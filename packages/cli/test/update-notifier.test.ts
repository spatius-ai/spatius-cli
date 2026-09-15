import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  utimes,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireLock,
  CACHE_FILE,
  CHECK_INTERVAL,
  FAILURE_INTERVAL,
  needsCheck,
  readCache,
  releaseLock,
  writeCache,
} from '../src/update/cache.js';
import { createNotifier } from '../src/update/notifier.js';
import { checkForUpdates } from '../src/update/check.js';
import pkg from '../package.json';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'spatius-notifier-'));
  directories.push(path);
  return path;
}
const cache = (now = Date.now()) => ({
  schemaVersion: 1 as const,
  versions: { latest: '99.0.0' },
  attemptedAt: now,
  checkedAt: now,
  failed: false,
});

describe('background update cache', () => {
  it('uses daily successful checks and hourly failed checks', async () => {
    const path = await directory();
    const now = Date.now();
    writeCache(path, cache(now));
    expect(readCache(path)).toEqual(cache(now));
    expect(needsCheck(readCache(path), now + CHECK_INTERVAL - 1)).toBe(false);
    expect(needsCheck(readCache(path), now + CHECK_INTERVAL)).toBe(true);
    writeCache(path, { ...cache(now), failed: true });
    expect(needsCheck(readCache(path), now + FAILURE_INTERVAL - 1)).toBe(false);
    expect(needsCheck(readCache(path), now + FAILURE_INTERVAL)).toBe(true);
  });
  it('ignores corrupt, oversized, future-dated, and symlinked cache files', async () => {
    const path = await directory();
    for (const content of [
      'no json',
      'x'.repeat(17000),
      JSON.stringify(cache(Date.now() + CHECK_INTERVAL)),
      JSON.stringify({ ...cache(), versions: { latest: 'bad' } }),
    ]) {
      await writeFile(join(path, CACHE_FILE), content);
      expect(readCache(path)).toBeUndefined();
    }
    await rm(join(path, CACHE_FILE));
    await writeFile(join(path, 'target'), JSON.stringify(cache()));
    await symlink(join(path, 'target'), join(path, CACHE_FILE));
    expect(readCache(path)).toBeUndefined();
  });
  it('deduplicates checks across foreground commands and recovers stale locks', async () => {
    const path = await directory();
    const launch = vi.fn();
    const make = () =>
      createNotifier({
        version: '1.0.0',
        args: ['schema'],
        env: { SPATIUS_CONFIG_DIR: path },
        launch,
      });
    const first = make();
    const second = make();
    first.finish();
    first.finish();
    second.finish();
    expect(launch).toHaveBeenCalledTimes(1);
    const old = new Date(Date.now() - 31000);
    await utimes(join(path, '.update-check-lock'), old, old);
    make().finish();
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it('saves successful checks and releases the lock', async () => {
    const path = await directory();
    const nonce = acquireLock(path)!;
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ latest: '2.0.0' }),
    );
    await checkForUpdates(path, nonce, new AbortController().signal, fetcher);
    expect(readCache(path)).toMatchObject({
      versions: { latest: '2.0.0' },
      failed: false,
    });
    expect(acquireLock(path)).toBeDefined();
  });
  it('retains known versions on offline failure and backs off without throwing', async () => {
    const path = await directory();
    writeCache(path, cache(Date.now() - CHECK_INTERVAL));
    await checkForUpdates(
      path,
      acquireLock(path)!,
      new AbortController().signal,
      async () => {
        throw new Error('offline');
      },
    );
    expect(readCache(path)).toMatchObject({
      failed: true,
      versions: { latest: '99.0.0' },
    });
    expect(needsCheck(readCache(path))).toBe(false);
  });
  it('does not fetch without lock ownership and applies the five-second fetch timeout', async () => {
    const path = await directory();
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('timeout');
    });
    await checkForUpdates(
      path,
      'not-an-owner',
      new AbortController().signal,
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await checkForUpdates(
      path,
      acquireLock(path)!,
      new AbortController().signal,
      fetcher,
    );
    expect(timeout).toHaveBeenCalledWith(5000);
  });
});

describe('notifier isolation', () => {
  it.each([
    ['completion', 'zsh'],
    ['__complete', '--', 'videos', 'create', '--fit', 'c'],
  ])('keeps completion commands silent and offline: %j', async (...args) => {
    const path = await directory();
    const launch = vi.fn();
    for (const cached of [
      undefined,
      cache(),
      cache(Date.now() - CHECK_INTERVAL),
    ]) {
      if (cached) writeCache(path, cached);
      const notifier = createNotifier({
        version: '1.0.0',
        args,
        env: { SPATIUS_CONFIG_DIR: path },
        launch,
      });
      expect(notifier.notice).toBeUndefined();
      notifier.finish();
    }
    expect(launch).not.toHaveBeenCalled();
  });
  it.each([
    ['install'],
    ['update'],
    ['update', '--channel', 'beta'],
    ['avatars', 'create', '--dry-run'],
  ])('suppresses automatic work for %j', async (...args) => {
    const path = await directory();
    writeCache(path, cache());
    const launch = vi.fn();
    const notifier = createNotifier({
      version: '1.0.0',
      args,
      env: { SPATIUS_CONFIG_DIR: path },
      launch,
    });
    expect(notifier.notice).toBeUndefined();
    notifier.finish();
    expect(launch).not.toHaveBeenCalled();
  });
  it('honors opt-out, fresh caches, and text-only discovery', async () => {
    const path = await directory();
    writeCache(path, cache());
    const launch = vi.fn();
    const disabled = createNotifier({
      version: '1.0.0',
      args: ['schema'],
      env: { SPATIUS_CONFIG_DIR: path, SPATIUS_NO_UPDATE_NOTIFIER: '1' },
      launch,
    });
    expect(disabled.notice).toBeUndefined();
    disabled.finish();
    const fresh = createNotifier({
      version: '1.0.0',
      args: ['schema'],
      env: { SPATIUS_CONFIG_DIR: path },
      launch,
    });
    expect(fresh.notice?.command).toBe('spatius update');
    fresh.finish();
    writeCache(path, cache(Date.now() - CHECK_INTERVAL));
    for (const args of [[], ['--help'], ['--version']]) {
      const notifier = createNotifier({
        version: '1.0.0',
        args,
        env: { SPATIUS_CONFIG_DIR: path },
        launch,
      });
      expect(notifier.notice).toBeDefined();
      notifier.finish();
    }
    expect(launch).not.toHaveBeenCalled();
  });
  it('contains unwritable cache locations and failed spawns', async () => {
    const path = await directory();
    await writeFile(join(path, 'file'), 'not a directory');
    const notifier = createNotifier({
      version: '1.0.0',
      args: ['schema'],
      env: { SPATIUS_CONFIG_DIR: join(path, 'file') },
    });
    expect(() => notifier.finish()).not.toThrow();
    const failure = createNotifier({
      version: '1.0.0',
      args: ['schema'],
      env: { SPATIUS_CONFIG_DIR: path },
      launch: () => {
        throw new Error('spawn failed');
      },
    });
    failure.finish();
    expect(readCache(path)?.failed).toBe(true);
    expect(acquireLock(path)).toBeDefined();
  });
  it('does not notify when the cache is older than the running version', async () => {
    const path = await directory();
    writeCache(path, { ...cache(), versions: { latest: '0.9.0' } });
    expect(
      createNotifier({
        version: '1.0.0',
        args: ['schema'],
        env: { SPATIUS_CONFIG_DIR: path },
      }).notice,
    ).toBeUndefined();
  });
});

const cwd = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function runCli(
  path: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SPATIUS_CONFIG_DIR: path,
      SPATIUS_NO_UPDATE_NOTIFIER: '',
      ...extraEnv,
    },
  });
}

it('keeps one JSON response, plain version stdout, original error codes, and dry-run isolation', async () => {
  const path = await directory();
  writeCache(path, cache());
  const success = runCli(path, ['schema', 'update']);
  expect(success.status).toBe(0);
  const envelope = JSON.parse(success.stdout);
  expect(envelope).toMatchObject({
    ok: true,
    updateAvailable: {
      command: 'spatius update',
      currentVersion: pkg.version,
      latestVersion: '99.0.0',
    },
  });
  expect(success.stderr).toBe('');
  const failed = runCli(path, ['unknown-command']);
  expect(failed.status).toBe(2);
  expect(failed.stdout).toBe('');
  expect(JSON.parse(failed.stderr)).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGUMENT' },
    updateAvailable: { command: 'spatius update' },
  });
  const version = runCli(path, ['--version']);
  expect(version.stdout).toBe(pkg.version + '\n');
  expect(version.stderr).toContain('Run spatius update.');
  expect(runCli(path, ['--help']).stderr).toContain('Run spatius update.');
  expect(
    runCli(path, ['--version'], { SPATIUS_NO_UPDATE_NOTIFIER: '1' }).stderr,
  ).toBe('');
  const before = await readFile(join(path, CACHE_FILE), 'utf8');
  const dry = runCli(path, [
    'avatars',
    'create',
    '--dry-run',
    '--image',
    'https://example.com/face.png',
    '--name',
    'Test',
  ]);
  expect(dry.status).toBe(0);
  expect(JSON.parse(dry.stdout).updateAvailable).toBeUndefined();
  expect(await readFile(join(path, CACHE_FILE), 'utf8')).toBe(before);
}, 20000);

it('finishes a normal CLI invocation while the detached registry request is stalled', async () => {
  const path = await directory();
  const marker = join(path, 'fetch-started');
  const preload = join(path, 'stall.mjs');
  await writeFile(
    preload,
    `import { writeFileSync } from 'node:fs';
    globalThis.fetch = async (_url, options) => {
      writeFileSync(${JSON.stringify(marker)}, 'started');
      return new Promise((_, reject) => {
        const keepAlive = setInterval(() => {}, 1000);
        options.signal.addEventListener('abort', () => { clearInterval(keepAlive); reject(options.signal.reason); }, { once: true });
      });
    };`,
  );
  const started = Date.now();
  const result = await new Promise<{ code: number | null; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', preload, '--import', 'tsx', cli, 'schema'],
        {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            SPATIUS_CONFIG_DIR: path,
            SPATIUS_NO_UPDATE_NOTIFIER: '',
          },
        },
      );
      let stdout = '';
      child.stdout.on('data', (bytes) => {
        stdout += bytes;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
    },
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).ok).toBe(true);
  expect(Date.now() - started).toBeLessThan(4000);
  // Wait for helper completion before deleting its fixture, never contact npm.
  await vi.waitFor(
    async () => expect(await readFile(marker, 'utf8')).toBe('started'),
    { timeout: 3000 },
  );
  await vi.waitFor(() => expect(readCache(path)?.failed).toBe(true), {
    timeout: 7000,
  });
  const nonce = acquireLock(path);
  expect(nonce).toBeDefined();
  releaseLock(path, nonce!);
}, 15000);
