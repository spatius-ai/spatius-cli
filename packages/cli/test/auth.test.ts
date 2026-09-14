import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../src/auth/index.js';
import { AuthStorage, type Profile } from '../src/auth/storage.js';

const studioOrigin = 'https://api.studio.example.test';
const studioWebOrigin = 'https://app.example.test';
const consoleOrigin = 'https://console.example.test';
const mediaOrigin = 'https://media.example.test';
const userId = '12345678-1234-4234-8234-123456789012';
const otherUser = '12345678-1234-4234-8234-123456789013';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const originKey = hash(`${studioOrigin}\n${consoleOrigin}`);
const profileKey = hash(`${originKey}\n${userId}`);
const locations: string[] = [];

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'spatius-auth-test-'));
  locations.push(path);
  return path;
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
function key(value = 'synthetic-key', createdAt = '2026-01-01T00:00:00Z') {
  return { apiKey: value, createdAt };
}
function app(appId = 'app_cli', keys = [key()], name = 'Spatius CLI') {
  return { appId, name, createdAt: '2026-01-01T00:00:00Z', apiKeys: keys };
}
function manager(configDir: string, fetcher: typeof fetch) {
  return new AuthManager({
    studioOrigin,
    studioWebOrigin,
    consoleOrigin,
    mediaOrigin,
    configDir,
    fetch: fetcher,
  });
}

async function seed(configDir: string, override: Partial<Profile> = {}) {
  const storage = new AuthStorage(configDir);
  await storage.locked(async (state) => {
    state.active[originKey] = profileKey;
    state.profiles[profileKey] = {
      userId,
      studioOrigin,
      consoleOrigin,
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...override,
    };
    await storage.write(state);
  });
}

function client(
  handler: (url: URL, options: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return vi.fn(async (input, options = {}) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(studioOrigin);
    if (url.pathname === '/v1/auth/me') return json({ user: { id: userId } });
    return handler(url, options);
  });
}

afterEach(async () => {
  for (const path of locations.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe('persistent login', () => {
  it('uses separate API/frontend origins for S256 login, ignores invalid callbacks, and stores only private credentials', async () => {
    const configDir = await directory();
    let session: Record<string, string>;
    let callbackResult: Promise<void> | undefined;
    let exchanges = 0;
    const fetcher = client((url, options) => {
      expect(options.redirect).toBe('error');
      if (url.pathname === '/v1/cli/auth/sessions') {
        session = JSON.parse(String(options.body));
        expect(session.clientName).toBe('Spatius CLI');
        expect(session.codeChallengeMethod).toBe(
          'CLI_AUTH_CODE_CHALLENGE_METHOD_S256',
        );
        return json({
          authRequestId: 'test-request',
          authorizeUrl: `${studioWebOrigin}/cli/auth/test-request`,
          expiresIn: 600,
        });
      }
      if (url.pathname === '/v1/cli/auth/token') {
        exchanges++;
        const body = JSON.parse(String(options.body));
        expect(
          createHash('sha256').update(body.codeVerifier).digest('base64url'),
        ).toBe(session.codeChallenge);
        expect(body.authCode).toBe('synthetic-code');
        return json({
          user: { id: userId },
          token: {
            accessToken: 'synthetic-access',
            refreshToken: 'synthetic-refresh',
            expiresIn: 3600,
          },
        });
      }
      throw new Error('Unexpected route');
    });
    const auth = manager(configDir, fetcher);
    const status = await auth.login({
      noBrowser: true,
      onAuthorize: () => {
        callbackResult = (async () => {
          const url = new URL(session.redirectUri!);
          url.search = new URLSearchParams({
            auth_request_id: 'test-request',
            auth_code: 'synthetic-code',
            state: 'incorrect',
          }).toString();
          expect((await fetch(url)).status).toBe(400);
          url.searchParams.set('state', session.state!);
          expect((await fetch(url)).status).toBe(200);
        })();
      },
    });
    await callbackResult;
    expect(exchanges).toBe(1);
    expect(status).toMatchObject({ authenticated: true, userId, profileKey });
    expect(JSON.stringify(status)).not.toContain('synthetic-');
    expect((await stat(join(configDir, 'auth.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    expect(await auth.identity()).toEqual({ userId, profileKey });
    await expect(fetch(session!.redirectUri!)).rejects.toThrow();
  });

  it('rejects an authorization link outside the configured Studio frontend origin', async () => {
    const auth = manager(
      await directory(),
      client(() =>
        json({
          authRequestId: 'request',
          authorizeUrl: 'https://untrusted.example/cli/auth/request',
        }),
      ),
    );
    await expect(auth.login({ noBrowser: true })).rejects.toMatchObject({
      code: 'UNSAFE_AUTH_URL',
    });
  });

  it('times out and closes the callback listener', async () => {
    let redirect = '';
    const auth = manager(
      await directory(),
      client((_url, options) => {
        redirect = JSON.parse(String(options.body)).redirectUri;
        return json({
          authRequestId: 'request',
          authorizeUrl: `${studioWebOrigin}/cli/auth/request`,
        });
      }),
    );
    await expect(
      auth.login({ noBrowser: true, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' });
    await expect(fetch(redirect)).rejects.toThrow();
  });

  it('serializes rotating refresh across independent managers and saves replacement tokens', async () => {
    const configDir = await directory();
    await seed(configDir, { expiresAt: new Date(0).toISOString() });
    let refreshes = 0;
    const fetcher = client(async (_url, options) => {
      refreshes++;
      expect(JSON.parse(String(options.body))).toEqual({
        refreshToken: 'synthetic-refresh',
      });
      await delay(20);
      return json({
        token: {
          accessToken: 'rotated-access',
          refreshToken: 'rotated-refresh',
          expiresIn: 3600,
        },
      });
    });
    const tokens = await Promise.all(
      Array.from({ length: 6 }, () =>
        manager(configDir, fetcher).accessToken(),
      ),
    );
    expect(refreshes).toBe(1);
    expect(tokens).toEqual(Array(6).fill('rotated-access'));
    const state = JSON.parse(
      await readFile(join(configDir, 'auth.json'), 'utf8'),
    );
    expect(state.profiles[profileKey].refreshToken).toBe('rotated-refresh');
    expect(state.profiles[profileKey].refreshPending).toBeUndefined();
  });

  it('does not replay a refresh after its response is lost, including after restart', async () => {
    const configDir = await directory();
    await seed(configDir, { expiresAt: new Date(0).toISOString() });
    let refreshes = 0;
    const fetcher = client(() => {
      refreshes++;
      throw new Error('network lost');
    });
    await expect(
      manager(configDir, fetcher).accessToken(),
    ).rejects.toMatchObject({ code: 'AUTH_RELOGIN_REQUIRED' });
    await expect(
      manager(configDir, fetcher).accessToken(),
    ).rejects.toMatchObject({ code: 'AUTH_RELOGIN_REQUIRED' });
    expect(refreshes).toBe(1);
    expect(await manager(configDir, fetcher).status()).toEqual({
      authenticated: false,
    });
  });

  it('serializes refresh between separate CLI processes', async () => {
    const configDir = await directory();
    await seed(configDir, { expiresAt: new Date(0).toISOString() });
    const source = new URL('../src/auth/index.ts', import.meta.url).href;
    const script = `
      import { AuthManager } from ${JSON.stringify(source)};
      import { appendFile } from 'node:fs/promises';
      import { setTimeout } from 'node:timers/promises';
      const configDir = process.argv[1];
      const manager = new AuthManager({
        configDir, studioOrigin: ${JSON.stringify(studioOrigin)}, consoleOrigin: ${JSON.stringify(consoleOrigin)}, mediaOrigin: ${JSON.stringify(mediaOrigin)},
        fetch: async () => {
          await appendFile(configDir + '/refresh-count', 'called\\n');
          await setTimeout(100);
          return new Response(JSON.stringify({ token: { accessToken: 'child-access', refreshToken: 'child-refresh', expiresIn: 3600 } }));
        },
      });
      console.log((await manager.accessToken()) === 'child-access');
    `;
    const invoke = () =>
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script, configDir],
        {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          timeout: 10_000,
        },
      );
    const results = await Promise.all([invoke(), invoke()]);
    expect(results.map((result) => result.stdout.trim())).toEqual([
      'true',
      'true',
    ]);
    expect(await readFile(join(configDir, 'refresh-count'), 'utf8')).toBe(
      'called\n',
    );
  });

  it('requires a new login when refresh response omits the rotated token', async () => {
    const configDir = await directory();
    await seed(configDir, { expiresAt: new Date(0).toISOString() });
    const auth = manager(
      configDir,
      client(() =>
        json({ token: { accessToken: 'new-access', expiresIn: 3600 } }),
      ),
    );
    await expect(auth.accessToken()).rejects.toMatchObject({
      code: 'AUTH_RELOGIN_REQUIRED',
    });
  });

  it('isolates users and API origins and rejects mismatched server identity', async () => {
    const configDir = await directory();
    await seed(configDir, { appId: 'app_cli', apiKey: 'synthetic-key' });
    const fetcher: typeof fetch = async () => json({ user: { id: otherUser } });
    await expect(
      manager(configDir, fetcher).credentials(),
    ).rejects.toMatchObject({ code: 'AUTH_IDENTITY_MISMATCH' });
    const other = new AuthManager({
      configDir,
      studioOrigin,
      mediaOrigin,
      consoleOrigin: 'https://other.example.test',
      fetch: fetcher,
    });
    expect(await other.status()).toEqual({ authenticated: false });
    await expect(other.credentials()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('clears local secrets on logout even if remote revocation fails', async () => {
    const configDir = await directory();
    await seed(configDir, { appId: 'app_cli', apiKey: 'synthetic-key' });
    const auth = manager(
      configDir,
      client(() => {
        throw new Error('offline');
      }),
    );
    expect(await auth.logout()).toEqual({
      authenticated: false,
      revoked: false,
    });
    const contents = await readFile(join(configDir, 'auth.json'), 'utf8');
    expect(contents).not.toContain('synthetic-');
    expect(contents).toContain('app_cli');
    await expect(auth.credentials()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('rejects symlink credential files and overly broad permissions', async () => {
    const configDir = await directory();
    const target = join(await directory(), 'secret');
    await writeFile(target, '{}', { mode: 0o600 });
    await symlink(target, join(configDir, 'auth.json'));
    await expect(
      manager(
        configDir,
        client(() => json({})),
      ).status(),
    ).rejects.toMatchObject({ code: 'UNSAFE_AUTH_STORAGE' });
    await rm(join(configDir, 'auth.json'));
    await seed(configDir);
    await chmod(join(configDir, 'auth.json'), 0o644);
    await expect(
      manager(
        configDir,
        client(() => json({})),
      ).status(),
    ).rejects.toMatchObject({ code: 'UNSAFE_AUTH_STORAGE' });
  });
});

describe('app bootstrap', () => {
  it('creates one app and key under concurrent setup and never exposes keys in metadata', async () => {
    const configDir = await directory();
    await seed(configDir);
    let created = false;
    let createdKey = false;
    const mutations: string[] = [];
    const fetcher = client((url, options) => {
      if (options.method === 'POST') {
        mutations.push(url.pathname);
        if (url.pathname === '/v1/apps') {
          created = true;
          return json({ appId: 'app_cli' });
        }
        createdKey = true;
        return json({ apiKey: key() });
      }
      if (url.pathname === '/v1/apps')
        return json({
          apps: created ? [app('app_cli', createdKey ? [key()] : [])] : [],
          pagination: {},
        });
      return json({ app: app('app_cli', createdKey ? [key()] : []) });
    });
    const results = await Promise.all(
      Array.from({ length: 3 }, () => manager(configDir, fetcher).setup()),
    );
    expect(mutations).toEqual(['/v1/apps', '/v1/apps/app_cli/api-keys']);
    expect(JSON.stringify(results)).not.toContain('synthetic-key');
    expect(await manager(configDir, fetcher).credentials()).toEqual({
      appId: 'app_cli',
      apiKey: 'synthetic-key',
      userId,
    });
  });

  it('reconciles a deleted cached app and bootstraps a replacement without retaining its old key state', async () => {
    const configDir = await directory();
    await seed(configDir, {
      appId: 'app_deleted',
      apiKey: 'deleted-key',
      pendingKey: true,
    });
    const posts: string[] = [];
    let created = false;
    let keyed = false;
    const fetcher = client((url, options) => {
      if (url.pathname === '/v1/apps/app_deleted') return json({}, 404);
      if (options.method === 'POST') {
        posts.push(url.pathname);
        if (url.pathname === '/v1/apps') {
          created = true;
          return json({ appId: 'app_new' });
        }
        keyed = true;
        return json({ apiKey: key('replacement-key') });
      }
      const current = app('app_new', keyed ? [key('replacement-key')] : []);
      return url.pathname === '/v1/apps'
        ? json({ apps: created ? [current] : [] })
        : json({ app: current });
    });
    const auth = manager(configDir, fetcher);
    expect(await auth.setup()).toMatchObject({
      appId: 'app_new',
      reused: false,
    });
    expect(posts).toEqual(['/v1/apps', '/v1/apps/app_new/api-keys']);
    expect((await auth.credentials()).apiKey).toBe('replacement-key');
    expect(await readFile(join(configDir, 'auth.json'), 'utf8')).not.toContain(
      'deleted-key',
    );
  });
  it('does not replace an unavailable explicitly selected app', async () => {
    const configDir = await directory();
    await seed(configDir);
    const fetcher = client((url, options) => {
      expect(url.pathname).toBe('/v1/apps/app_missing');
      expect(options.method).toBe('GET');
      return json({}, 404);
    });
    await expect(
      manager(configDir, fetcher).setup({ appId: 'app_missing' }),
    ).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('follows every app page and picks the oldest existing key without creating more', async () => {
    const configDir = await directory();
    await seed(configDir);
    let pages = 0;
    const fetcher = client((url, options) => {
      expect(options.method).toBe('GET');
      if (url.pathname === '/v1/apps') {
        pages++;
        expect(url.searchParams.get('pagination.pageSize')).toBe('100');
        if (!url.searchParams.get('pagination.pageToken'))
          return json({
            apps: [app('unrelated', [], 'Other app')],
            pagination: { nextPageToken: '100' },
          });
        expect(url.searchParams.get('pagination.pageToken')).toBe('100');
        return json({
          apps: [
            app('app_cli', [
              key('new-key', '2026-02-01T00:00:00Z'),
              key('old-key'),
            ]),
          ],
          pagination: {},
        });
      }
      return json({ app: app('app_cli', [key('old-key')]) });
    });
    const auth = manager(configDir, fetcher);
    expect(await auth.setup()).toMatchObject({
      appId: 'app_cli',
      reused: true,
    });
    expect(pages).toBe(2);
    expect((await auth.credentials()).apiKey).toBe('old-key');
  });

  it('requires explicit selection among multiple matches, returning only safe app metadata', async () => {
    const configDir = await directory();
    await seed(configDir);
    const fetcher = client((url, options) => {
      expect(options.method).toBe('GET');
      if (url.pathname === '/v1/apps')
        return json({ apps: [app('a'), app('b')] });
      return json({ app: app('b') });
    });
    const auth = manager(configDir, fetcher);
    try {
      await auth.setup();
      expect.fail('Expected selection error');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'APP_SELECTION_REQUIRED',
        options: { details: { apps: [{ appId: 'a' }, { appId: 'b' }] } },
      });
      expect(JSON.stringify(error)).not.toContain('synthetic-key');
    }
    expect(await auth.setup({ appId: 'b' })).toMatchObject({ appId: 'b' });
  });

  it('recovers lost app and key responses using reads without replaying POSTs', async () => {
    const configDir = await directory();
    await seed(configDir);
    let created = false;
    let keyed = false;
    let posts = 0;
    const auth = manager(
      configDir,
      client((url, options) => {
        if (options.method === 'POST') {
          posts++;
          if (url.pathname === '/v1/apps') created = true;
          else keyed = true;
          throw new Error('lost response');
        }
        const current = app('app_cli', keyed ? [key()] : []);
        return url.pathname === '/v1/apps'
          ? json({ apps: created ? [current] : [] })
          : json({ app: current });
      }),
    );
    expect(await auth.setup()).toMatchObject({ appId: 'app_cli' });
    expect(posts).toBe(2);
    expect((await auth.credentials()).apiKey).toBe('synthetic-key');
  });

  it('persists an uncertain app creation and requires an explicit retry if no app appears', async () => {
    const configDir = await directory();
    await seed(configDir);
    let posts = 0;
    const fetcher = client((_url, options) => {
      if (options.method === 'POST') {
        posts++;
        throw new Error('unknown');
      }
      return json({ apps: [] });
    });
    await expect(manager(configDir, fetcher).setup()).rejects.toMatchObject({
      code: 'BOOTSTRAP_UNCERTAIN',
    });
    await expect(manager(configDir, fetcher).setup()).rejects.toMatchObject({
      code: 'BOOTSTRAP_UNCERTAIN',
    });
    expect(posts).toBe(1);
    await expect(
      manager(configDir, fetcher).setup({ retryUncertain: true }),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_UNCERTAIN' });
    expect(posts).toBe(2);
  });

  it('persists the app ID before key creation and recovers setup after restart', async () => {
    const configDir = await directory();
    await seed(configDir);
    let keyAppears = false;
    let keyPosts = 0;
    const fetcher = client((url, options) => {
      if (options.method === 'POST' && url.pathname === '/v1/apps')
        return json({ appId: 'app_cli' });
      if (options.method === 'POST') {
        keyPosts++;
        throw new Error('unknown');
      }
      if (url.pathname === '/v1/apps') return json({ apps: [] });
      return json({ app: app('app_cli', keyAppears ? [key()] : []) });
    });
    await expect(manager(configDir, fetcher).setup()).rejects.toMatchObject({
      code: 'BOOTSTRAP_UNCERTAIN',
    });
    const state = JSON.parse(
      await readFile(join(configDir, 'auth.json'), 'utf8'),
    );
    expect(state.profiles[profileKey]).toMatchObject({
      appId: 'app_cli',
      pendingKey: true,
    });
    keyAppears = true;
    expect(await manager(configDir, fetcher).setup()).toMatchObject({
      appId: 'app_cli',
    });
    expect(keyPosts).toBe(1);
  });

  it('credential reads do not silently bootstrap when their selected app is unavailable', async () => {
    const configDir = await directory();
    await seed(configDir, { appId: 'app_deleted', apiKey: 'synthetic-key' });
    const auth = manager(
      configDir,
      client((_url, options) => {
        expect(options.method).toBe('GET');
        return json({ errors: [{ status: '404', code: 'NOT_FOUND' }] }, 404);
      }),
    );
    await expect(auth.credentials()).rejects.toMatchObject({
      code: 'APP_UNAVAILABLE',
    });
  });

  it('does not trust a successful HTTP response containing a Studio auth error', async () => {
    const configDir = await directory();
    await seed(configDir);
    const auth = manager(
      configDir,
      client(() =>
        json({
          errors: [{ code: 'FORBIDDEN', detail: 'synthetic-private-value' }],
        }),
      ),
    );
    await expect(auth.setup()).rejects.toMatchObject({
      code: 'STUDIO_FORBIDDEN',
      options: { status: 403 },
    });
    expect(await readFile(join(configDir, 'auth.json'), 'utf8')).not.toContain(
      'synthetic-private-value',
    );
  });
});

describe('installer Studio cancellation', () => {
  it('does not make a request when its shared signal is already aborted', async () => {
    const configDir = await directory();
    await seed(configDir);
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    const auth = new AuthManager({
      studioOrigin,
      consoleOrigin,
      mediaOrigin,
      configDir,
      fetch: fetcher,
      signal: controller.signal,
    });
    await expect(auth.status()).rejects.toMatchObject({
      code: 'INTERRUPTED',
      options: { exitCode: 130 },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cancels app creation without replaying it and retains pending state for reconciliation', async () => {
    const configDir = await directory();
    await seed(configDir);
    const controller = new AbortController();
    const posts: string[] = [];
    const fetcher = client(async (url, options) => {
      if (options.method !== 'POST') return json({ apps: [] });
      posts.push(url.pathname);
      const storage = await new AuthStorage(configDir).read();
      expect(storage.profiles[profileKey]?.pendingApp).toBe(true);
      controller.abort();
      expect(options.signal?.aborted).toBe(true);
      throw new DOMException('Aborted', 'AbortError');
    });
    const auth = new AuthManager({
      studioOrigin,
      consoleOrigin,
      mediaOrigin,
      configDir,
      fetch: fetcher,
      signal: controller.signal,
    });
    await expect(auth.setup()).rejects.toMatchObject({
      code: 'INTERRUPTED',
      options: { exitCode: 130 },
    });
    expect(posts).toEqual(['/v1/apps']);
    expect(
      (await new AuthStorage(configDir).read()).profiles[profileKey]
        ?.pendingApp,
    ).toBe(true);
  });
});
