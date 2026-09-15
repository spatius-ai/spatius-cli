import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchVersions,
  registryVersions,
  selectVersion,
} from '../src/update/registry.js';
import { runUpdate } from '../src/update/index.js';
import { inspectSkills } from '../src/update/skills.js';
import { skillNames } from '../src/install/assets.js';
import type { ProcessRequest } from '../src/install/process.js';
import { buildProgram } from '../src/commands.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const signal = () => new AbortController().signal;

describe('npm release selection', () => {
  it.each([
    ['1.0.0', { latest: '1.0.1', beta: '2.0.0-beta.1' }, undefined, '1.0.1'],
    [
      '1.0.0-beta.1',
      { latest: '0.9.0', beta: '1.0.0-beta.10' },
      undefined,
      '1.0.0-beta.10',
    ],
    [
      '1.0.0-beta.10',
      { latest: '1.0.0', beta: '1.0.0-beta.11' },
      undefined,
      '1.0.0',
    ],
    [
      '1.0.0',
      { latest: '1.0.0', beta: '2.0.0-beta.1' },
      'beta',
      '2.0.0-beta.1',
    ],
    ['1.0.0', { latest: '0.9.0' }, 'latest', '1.0.0'],
    ['1.0.0-beta.2', { beta: '1.0.0-beta.2' }, undefined, '1.0.0-beta.2'],
  ] as const)(
    'selects without downgrading %s',
    (current, tags, channel, expected) => {
      expect(selectVersion(current, tags, channel)).toBe(expected);
    },
  );
  it.each([
    null,
    [],
    {},
    { latest: 'latest' },
    { latest: 'v1.0.0' },
    { latest: '1.0.0-beta.1' },
    { beta: '1.0.0-beta.01' },
  ])('rejects malformed tags %j', (tags) => {
    expect(() => registryVersions(tags)).toThrow();
  });
  it('rejects a missing selected channel', () => {
    expect(() => selectVersion('1.0.0', { beta: '2.0.0-beta.1' })).toThrow(
      /unavailable/,
    );
  });
  it('reads only public dist-tags with a deadline and no credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        latest: '1.2.3',
        beta: '2.0.0-beta.0',
        ignored: 'other',
      }),
    );
    expect(await fetchVersions(signal(), fetcher)).toEqual({
      latest: '1.2.3',
      beta: '2.0.0-beta.0',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://registry.npmjs.org/-/package/@spatius%2Fcli/dist-tags',
      {
        signal: expect.any(AbortSignal),
        redirect: 'error',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      },
    );
  });
  it.each([500, 302, 200])(
    'contains registry HTTP/parse failures (%s)',
    async (status) => {
      await expect(
        fetchVersions(
          signal(),
          async () => new Response('private diagnostics', { status }),
        ),
      ).rejects.toMatchObject({ code: 'UPDATE_REGISTRY_UNAVAILABLE' });
    },
  );
  it('rejects oversized responses and respects cancellation', async () => {
    await expect(
      fetchVersions(signal(), async () => new Response('x'.repeat(17000))),
    ).rejects.toMatchObject({ code: 'UPDATE_REGISTRY_UNAVAILABLE' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchVersions(controller.signal, async (_url, options) => {
        options!.signal!.throwIfAborted();
        throw new Error();
      }),
    ).rejects.toMatchObject({ code: 'INTERRUPTED' });
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'spatius-update-'));
  directories.push(directory);
  const bundled = join(directory, 'package', 'skills');
  const installed = join(directory, 'installed');
  const contents = (name: string, version = '1.1.0') =>
    `---\nname: ${name}\nmetadata:\n  version: "${version}"\n---\nGuidance.\n`;
  for (const base of [bundled, installed])
    for (const name of skillNames) {
      await mkdir(join(base, name), { recursive: true });
      await writeFile(join(base, name, 'SKILL.md'), contents(name));
    }
  const entries = (scope: string) =>
    skillNames.map((name) => ({
      name,
      scope,
      path: join(installed, name),
      agents: ['Codex'],
    }));
  const runner = vi.fn(async (request: ProcessRequest) => ({
    code: 0,
    stdout: request.args.includes('list')
      ? JSON.stringify(
          entries(request.args.includes('--global') ? 'global' : 'project'),
        )
      : 'Human skills output',
    stderr: '',
  }));
  const services = {
    prerequisites: vi.fn(async () => {}),
    inspectGlobal: vi.fn(async () => ({
      version: '1.0.0',
      entry: join(directory, 'package', 'dist', 'cli.js'),
      binary: join(directory, 'bin', 'spatius'),
      binDirectory: join(directory, 'bin'),
    })),
    installCli: vi.fn(async (version: string) => ({
      version,
      reused: version === '1.0.0',
      available: true,
    })),
  };
  const options = {
    version: '1.0.0',
    cwd: directory,
    signal: signal(),
    runner,
    services,
    fetcher: vi.fn<typeof fetch>(async () =>
      Response.json({ latest: '1.1.0' }),
    ),
  };
  return {
    directory,
    installed,
    bundled,
    contents,
    entries,
    runner,
    services,
    options,
  };
}

describe('non-interactive updater', () => {
  it('verifies the global CLI and skills with captured streams and original cwd', async () => {
    const h = await fixture();
    const result = await runUpdate(h.options);
    expect(result.cli?.version).toBe('1.1.0');
    expect(result.skills).toHaveLength(6);
    expect(result.skills.every((skill) => skill.status === 'matching')).toBe(
      true,
    );
    expect(h.runner.mock.calls[0]![0]).toEqual({
      command: 'npx',
      args: ['--yes', 'skills', 'update', ...skillNames, '--yes'],
      cwd: h.directory,
      signal: h.options.signal,
    });
    expect(
      h.runner.mock.calls.every(
        ([request]) => !request.inherit && request.cwd === h.directory,
      ),
    ).toBe(true);
  });
  it('still runs skills update when the global CLI is current and retains PATH warnings', async () => {
    const h = await fixture();
    h.options.version = '1.1.0';
    h.services.installCli.mockResolvedValue({
      version: '1.1.0',
      reused: true,
      available: false,
      ...{ warning: 'Another executable takes precedence.' },
    });
    const result = await runUpdate(h.options);
    expect(result.cli).toMatchObject({
      reused: true,
      available: false,
      warning: expect.stringContaining('precedence'),
    });
    expect(result.skillsCommand).toBe('completed');
  });
  it('does not downgrade a newer global installation invoked by an old npx CLI', async () => {
    const h = await fixture();
    h.services.inspectGlobal.mockResolvedValue({
      ...(await h.services.inspectGlobal()),
      version: '1.1.0',
    });
    h.options.fetcher.mockResolvedValue(Response.json({ latest: '1.0.0' }));
    expect((await runUpdate(h.options)).targetVersion).toBe('1.1.0');
  });
  it.each(['mismatched', 'missing-version', 'unverifiable'] as const)(
    'reports %s skills without replacing or repairing them',
    async (status) => {
      const h = await fixture();
      const path = join(h.installed, skillNames[0]!, 'SKILL.md');
      const content =
        status === 'mismatched'
          ? h.contents(skillNames[0]!, '1.0.0')
          : status === 'missing-version'
            ? `---\nname: ${skillNames[0]}\n---\nLegacy skill.`
            : 'Malformed skill.';
      await writeFile(path, content);
      await expect(runUpdate(h.options)).rejects.toMatchObject({
        code: 'UPDATE_SKILLS_INCOMPLETE',
        options: {
          details: {
            cli: { version: '1.1.0' },
            skillsCommand: 'completed',
            skills: expect.arrayContaining([
              expect.objectContaining({ status }),
            ]),
          },
        },
      });
      expect(await readFile(path, 'utf8')).toBe(content);
      expect(
        h.runner.mock.calls.some(([request]) => request.args.includes('add')),
      ).toBe(false);
    },
  );
  it('reports no installed skills without installing any', async () => {
    const h = await fixture();
    h.runner.mockResolvedValue({ code: 0, stdout: '[]', stderr: '' });
    const result = await runUpdate(h.options);
    expect(result.skills.every((skill) => skill.status === 'absent')).toBe(
      true,
    );
    expect(result.message).toContain('No Spatius skills');
  });
  it('rejects a bad target bundle before skill mutation', async () => {
    const h = await fixture();
    await writeFile(
      join(h.bundled, skillNames[0]!, 'SKILL.md'),
      h.contents(skillNames[0]!, '0.0.1'),
    );
    await expect(runUpdate(h.options)).rejects.toMatchObject({
      code: 'UPDATE_BUNDLE_MISMATCH',
      options: {
        details: { stage: 'bundled-skills', cli: { version: '1.1.0' } },
      },
    });
    expect(h.runner).not.toHaveBeenCalled();
  });
  it('retains completion on skill failure and interruption without exposing subprocess output', async () => {
    for (const code of [1, 130]) {
      const h = await fixture();
      h.runner.mockResolvedValueOnce({
        code,
        stdout: 'PRIVATE_DIAGNOSTIC',
        stderr: 'PRIVATE_DIAGNOSTIC',
      });
      const failure = await runUpdate(h.options).catch((error) => error);
      expect(failure.code).toBe(
        code === 130 ? 'INTERRUPTED' : 'UPDATE_SKILLS_FAILED',
      );
      expect(failure.options.details.cli.version).toBe('1.1.0');
      expect(JSON.stringify(failure)).not.toContain('PRIVATE_DIAGNOSTIC');
    }
  });
  it('classifies discovery failures as unverifiable rather than absent', async () => {
    const h = await fixture();
    h.runner.mockResolvedValue({ code: 0, stdout: 'not json', stderr: '' });
    const result = await inspectSkills({
      version: '1.1.0',
      runner: h.runner,
      cwd: h.directory,
      signal: signal(),
    });
    expect(result).toHaveLength(6);
    expect(result.every((skill) => skill.status === 'unverifiable')).toBe(true);
  });
  it('discovers update schema and rejects invalid channels without Studio context', async () => {
    const context = vi.fn(() => {
      throw new Error('No Studio access expected');
    });
    const emit = vi.fn();
    const program = buildProgram(context, emit, '1.0.0');
    program.configureOutput({ writeErr: () => {} });
    await program.parseAsync(['node', 'spatius', 'schema', 'update']);
    expect(emit.mock.calls[0]![0]).toMatchObject({
      commands: [
        { path: 'update', options: [{ choices: ['latest', 'beta'] }] },
      ],
      outputEnvelope: { updateAvailable: { optional: true } },
    });
    await expect(
      program.parseAsync(['node', 'spatius', 'update', '--channel', 'bad']),
    ).rejects.toThrow();
    expect(context).not.toHaveBeenCalled();
  });
});
