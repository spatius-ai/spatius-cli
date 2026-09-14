import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../src/auth/index.js';
import { AuthStorage, type Profile } from '../src/auth/storage.js';
import { buildProgram } from '../src/commands.js';
import { Workflows } from '../src/workflows/index.js';
import { StudioWorkflows, keyId } from '../src/workflows/studio.js';

const origin = 'https://studio.example.test';
const consoleOrigin = 'https://console.example.test';
const userId = '12345678-1234-4234-8234-123456789012';
const appId = 'app_example';
const secret = 'synthetic-studio-key';
const createdAt = '2026-01-01T00:00:00Z';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const originKey = hash(`${origin}\n${consoleOrigin}`);
const profileKey = hash(`${originKey}\n${userId}`);
const dirs: string[] = [];
const json = (value: unknown, status = 200) => Response.json(value, { status });

async function fixture(
  handler: (url: URL, options: RequestInit) => Response | Promise<Response>,
  profile: Partial<Profile> = {},
  signal?: AbortSignal,
) {
  const dir = await mkdtemp(join(tmpdir(), 'spatius-studio-test-'));
  dirs.push(dir);
  const storage = new AuthStorage(dir);
  await storage.locked(async (state) => {
    state.active[originKey] = profileKey;
    state.profiles[profileKey] = {
      userId,
      studioOrigin: origin,
      consoleOrigin,
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...profile,
    };
    await storage.write(state);
  });
  const fetcher = vi.fn<typeof fetch>(async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.origin === consoleOrigin) {
      expect(url.pathname).toBe('/v1/console/session-tokens');
      expect(options.redirect).toBe('error');
      expect(new Headers(options.headers).get('authorization')).toBeNull();
      expect(new Headers(options.headers).get('x-app-id')).toBeNull();
      expect(new Headers(options.headers).get('x-api-key')).not.toBeNull();
      return handler(url, options);
    }
    expect(url.origin).toBe(origin);
    expect(options.redirect).toBe('error');
    expect(new Headers(options.headers).get('authorization')).toBe(
      'Bearer synthetic-access',
    );
    expect(new Headers(options.headers).get('x-api-key')).toBeNull();
    expect(new Headers(options.headers).get('x-app-id')).toBeNull();
    if (url.pathname === '/v1/auth/me') return json({ user: { id: userId } });
    return handler(url, options);
  });
  const auth = new AuthManager({
    studioOrigin: origin,
    consoleOrigin,
    mediaOrigin: 'https://media.example.test',
    configDir: dir,
    fetch: fetcher,
    signal,
  });
  const events: Array<Record<string, unknown>> = [];
  const studio = new StudioWorkflows(auth, (event) =>
    events.push(event as Record<string, unknown>),
  );
  const run = async (args: string[]) => {
    let result: unknown;
    const program = buildProgram(
      () => ({
        auth,
        studio,
        workflows: new Workflows({
          auth,
          consoleOrigin,
          mediaOrigin: 'https://media.example.test',
          fetch: fetcher,
        }),
        signal: new AbortController().signal,
        progress: () => {},
      }),
      (data) => {
        result = data;
      },
      'test',
    );
    program.configureOutput({ writeErr: () => {} });
    await program.parseAsync(['node', 'spatius', ...args]);
    return result;
  };
  return {
    auth,
    studio,
    run,
    events,
    fetcher,
    storage,
    journal: async (id: string) =>
      readFile(join(dir, 'operations', profileKey, `${id}.json`), 'utf8'),
  };
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('Studio management commands', () => {
  it('generates the frontend 24-hour session token using the first Studio key and journals metadata only', async () => {
    const sessionToken = 'synthetic-session-token';
    const f = await fixture(
      async (url, options) => {
        if (url.origin === origin) {
          expect(url.pathname).toBe(`/v1/apps/${appId}/api-keys`);
          return json({
            apiKeys: [
              { apiKey: secret, createdAt },
              { apiKey: 'synthetic-second-key', createdAt },
            ],
          });
        }
        expect(options.method).toBe('POST');
        expect(new Headers(options.headers).get('x-api-key')).toBe(secret);
        const body = JSON.parse(String(options.body));
        expect(body).toEqual({
          expireAt: expect.any(Number),
          modelVersion: '',
        });
        expect(body.expireAt).toBeGreaterThanOrEqual(
          Math.floor(start / 1000) + 86400,
        );
        expect(body.expireAt).toBeLessThanOrEqual(
          Math.floor(Date.now() / 1000) + 86400,
        );
        const journal = JSON.parse(
          await f.journal(String(f.events[0]!.operationId)),
        );
        expect(journal).toMatchObject({
          type: 'session-token',
          state: 'submitting',
          input: { appId, keyId: keyId(secret), consoleOrigin, ...body },
        });
        return json({ sessionToken });
      },
      { appId: 'app_other', apiKey: 'synthetic-cached-key' },
    );
    const start = Date.now();
    const result = await f.run([
      'apps',
      'session-tokens',
      'create',
      '--app-id',
      appId,
    ]);
    expect(result).toMatchObject({
      sessionToken,
      appId,
      keyId: keyId(secret),
      expireAt: expect.any(Number),
      modelVersion: '',
      consoleOrigin,
    });
    const id = String(f.events[0]!.operationId);
    const journal = await f.journal(id);
    expect(JSON.parse(journal).state).toBe('accepted');
    expect(journal).not.toContain(secret);
    expect(journal).not.toContain(sessionToken);
    expect(JSON.stringify(f.events)).not.toContain(sessionToken);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect((await f.storage.read()).profiles[profileKey]).toMatchObject({
      appId: 'app_other',
      apiKey: 'synthetic-cached-key',
    });
    expect(
      f.fetcher.mock.calls.filter(([, options]) => options?.method === 'POST'),
    ).toHaveLength(1);
  });

  it('resolves an explicitly selected session-token key across pages', async () => {
    const f = await fixture((url, options) => {
      if (url.origin === consoleOrigin) {
        expect(new Headers(options.headers).get('x-api-key')).toBe(secret);
        return json({ sessionToken: 'synthetic-session-token' });
      }
      if (!url.searchParams.get('pagination.pageToken'))
        return json({
          apiKeys: [{ apiKey: 'synthetic-other-key', createdAt }],
          pagination: { nextPageToken: 'next' },
        });
      return json({ apiKeys: [{ apiKey: secret, createdAt }] });
    });
    expect(
      await f.run([
        'apps',
        'session-tokens',
        'create',
        '--app-id',
        appId,
        '--key-id',
        keyId(secret),
      ]),
    ).toMatchObject({ keyId: keyId(secret) });
  });

  it.each([undefined, keyId(secret)])(
    'does not create or substitute a key when none matches %s',
    async (fingerprint) => {
      const f = await fixture(() =>
        json({
          apiKeys: fingerprint
            ? [{ apiKey: 'synthetic-other-key', createdAt }]
            : [],
        }),
      );
      await expect(
        f.studio.createSessionToken(appId, fingerprint),
      ).rejects.toMatchObject({ code: 'APP_KEY_UNAVAILABLE' });
      expect(f.events).toEqual([]);
      expect(
        f.fetcher.mock.calls.every(([, options]) => options?.method === 'GET'),
      ).toBe(true);
    },
  );

  it.each([200, 401, 403, 429, 503])(
    'does not retry or expose session-token error payloads (HTTP %s)',
    async (status) => {
      const f = await fixture((url) => {
        if (url.origin === origin)
          return json({ apiKeys: [{ apiKey: secret, createdAt }] });
        return new Response(
          JSON.stringify({
            sessionToken: 'synthetic-rejected-token',
            error: { code: secret, message: secret },
          }),
          { status, headers: { 'x-request-id': secret } },
        );
      });
      let failure: unknown;
      try {
        await f.studio.createSessionToken(appId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: 'SESSION_TOKEN_FAILED',
        options: {
          retryable: false,
          details: {
            operationId: expect.any(String),
            expireAt: expect.any(Number),
          },
        },
      });
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain('synthetic-rejected-token');
      expect(
        f.fetcher.mock.calls.filter(
          ([, options]) => options?.method === 'POST',
        ),
      ).toHaveLength(1);
      const journal = JSON.parse(
        await f.journal(String(f.events[0]!.operationId)),
      );
      expect(journal.state).toBe(
        status >= 400 && status < 500 ? 'rejected' : 'submitting',
      );
    },
  );

  it.each(['network', 'missing-token', 'redirect'])(
    'handles session-token %s failures without replay',
    async (failure) => {
      const f = await fixture((url) => {
        if (url.origin === origin)
          return json({ apiKeys: [{ apiKey: secret, createdAt }] });
        if (failure === 'network') throw new Error(secret);
        return failure === 'redirect'
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://unexpected.example' },
            })
          : json({});
      });
      await expect(f.studio.createSessionToken(appId)).rejects.toMatchObject({
        code: 'SESSION_TOKEN_FAILED',
        options: { retryable: false },
      });
      expect(
        f.fetcher.mock.calls.filter(
          ([, options]) => options?.method === 'POST',
        ),
      ).toHaveLength(1);
    },
  );

  it('preserves the operation ID and exit 130 when session-token generation is interrupted', async () => {
    const controller = new AbortController();
    const f = await fixture(
      (url) => {
        if (url.origin === origin)
          return json({ apiKeys: [{ apiKey: secret, createdAt }] });
        controller.abort();
        throw new Error(secret);
      },
      {},
      controller.signal,
    );
    await expect(f.studio.createSessionToken(appId)).rejects.toMatchObject({
      code: 'INTERRUPTED',
      options: { exitCode: 130, details: { operationId: expect.any(String) } },
    });
    expect(
      JSON.parse(await f.journal(String(f.events[0]!.operationId))).state,
    ).toBe('submitting');
    expect(
      f.fetcher.mock.calls.filter(([, options]) => options?.method === 'POST'),
    ).toHaveLength(1);
  });
  it('lists and reads apps with sanitized metadata and no setup', async () => {
    const app = {
      appId,
      name: 'Demo',
      createdAt,
      apiKeys: [{ apiKey: secret, createdAt }],
    };
    const f = await fixture((url) => {
      if (url.pathname === '/v1/apps') return json({ apps: [app] });
      expect(url.pathname).toBe(`/v1/apps/${appId}`);
      return json({ app });
    });
    expect(await f.run(['apps', 'list'])).toEqual([
      { appId, name: 'Demo', createdAt },
    ]);
    expect(await f.run(['apps', 'get', appId])).toEqual({
      appId,
      name: 'Demo',
      createdAt,
      apiKeyCount: 1,
    });
  });

  it('journals resolved app input before one POST and resumes without submitting', async () => {
    const f = await fixture(async (url, options) => {
      expect(url.pathname).toBe('/v1/apps');
      expect(options.method).toBe('POST');
      expect(JSON.parse(String(options.body))).toEqual({ name: 'Demo' });
      expect(
        JSON.parse(await f.journal(String(f.events[0]!.operationId))),
      ).toMatchObject({ state: 'submitting', input: { name: 'Demo' } });
      return json({ appId });
    });
    const result = await f.run(['apps', 'create', '--name', ' Demo ']);
    expect(result).toMatchObject({
      appId,
      name: 'Demo',
      operationId: f.events[0]!.operationId,
    });
    expect(
      await f.run([
        'apps',
        'create',
        '--resume',
        String(f.events[0]!.operationId),
      ]),
    ).toEqual(result);
    expect(
      f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
    expect(
      (await f.storage.read()).profiles[profileKey]?.appId,
    ).toBeUndefined();
  });

  it('lists hidden key metadata and only reveals on explicit request', async () => {
    const f = await fixture((url) => {
      expect(url.pathname).toBe(`/v1/apps/${appId}/api-keys`);
      expect(url.searchParams.get('pagination.pageSize')).toBe('7');
      expect(url.searchParams.get('pagination.pageToken')).toBe('a+&/');
      return json({
        apiKeys: [{ apiKey: secret, createdAt, createdBy: userId }],
        pagination: { nextPageToken: 'next' },
      });
    });
    const args = [
      'apps',
      'keys',
      'list',
      '--app-id',
      appId,
      '--page-size',
      '7',
      '--page-token',
      'a+&/',
    ];
    const hidden = await f.run(args);
    expect(hidden).toMatchObject({
      apiKeys: [{ keyId: keyId(secret), createdAt, createdBy: userId }],
      pagination: { nextPageToken: 'next' },
    });
    expect(JSON.stringify(hidden)).not.toContain(secret);
    expect(await f.run([...args, '--show-secrets'])).toMatchObject({
      apiKeys: [{ apiKey: secret }],
    });
  });

  it('creates a key with the frontend empty body and keeps secrets out of journals', async () => {
    let posts = 0;
    const f = await fixture(async (url, options) => {
      expect(url.pathname).toBe(`/v1/apps/${appId}/api-keys`);
      if (options.method === 'POST') {
        posts++;
        expect(JSON.parse(String(options.body))).toEqual({});
        expect(
          JSON.parse(await f.journal(String(f.events[0]!.operationId))),
        ).toMatchObject({ state: 'submitting', input: { appId } });
        return json({ apiKey: { apiKey: secret, createdAt } });
      }
      return json({ apiKeys: [{ apiKey: secret, createdAt }] });
    });
    const hidden = await f.run(['apps', 'keys', 'create', '--app-id', appId]);
    expect(hidden).toMatchObject({ appId, keyId: keyId(secret) });
    expect(JSON.stringify(hidden)).not.toContain(secret);
    const id = String(f.events[0]!.operationId);
    expect(
      await f.run(['apps', 'keys', 'create', '--resume', id, '--show-secrets']),
    ).toMatchObject({ apiKey: secret, operationId: id });
    expect(await f.journal(id)).not.toContain(secret);
    expect(JSON.stringify(f.events)).not.toContain(secret);
    expect(posts).toBe(1);
  });

  it.each(['app', 'key'] as const)(
    'never replays an uncertain %s creation after restart',
    async (kind) => {
      const f = await fixture(() => {
        throw new Error(`network lost ${secret}`);
      });
      const args =
        kind === 'app'
          ? ['apps', 'create', '--name', 'Demo']
          : ['apps', 'keys', 'create', '--app-id', appId];
      await expect(f.run(args)).rejects.toMatchObject({
        code: 'STUDIO_CREATION_UNCERTAIN',
        options: { details: { operationId: expect.any(String) } },
      });
      const id = String(f.events[0]!.operationId);
      const restarted = new StudioWorkflows(f.auth);
      await expect(
        kind === 'app'
          ? restarted.createApp({ resume: id })
          : restarted.createKey({ resume: id }),
      ).rejects.toMatchObject({ code: 'STUDIO_CREATION_UNCERTAIN' });
      expect(
        f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
      ).toHaveLength(1);
      expect(await f.journal(id)).not.toContain(secret);
    },
  );

  it.each([401, 403, 429, 503])(
    'does not retry a creation rejected with HTTP %s or leak backend errors',
    async (status) => {
      const f = await fixture(() =>
        json({ error: { message: secret } }, status),
      );
      let caught: unknown;
      try {
        await f.run(['apps', 'keys', 'create', '--app-id', appId]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect(JSON.stringify(caught)).not.toContain(secret);
      const id = String(f.events[0]!.operationId);
      await expect(f.studio.createKey({ resume: id })).rejects.toMatchObject({
        code:
          status < 500
            ? 'STUDIO_CREATION_REJECTED'
            : 'STUDIO_CREATION_UNCERTAIN',
      });
      expect(
        f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
      ).toHaveLength(1);
    },
  );

  it('finds keys across pages and deletes by fingerprint while clearing selected credentials', async () => {
    const f = await fixture(
      (url, options) => {
        if (options.method === 'DELETE') {
          expect(url.pathname).toBe(`/v1/apps/${appId}/api-keys/${secret}`);
          expect(options.body).toBeUndefined();
          return new Response(null, { status: 204 });
        }
        if (!url.searchParams.get('pagination.pageToken'))
          return json({ pagination: { nextPageToken: 'second' } });
        return json({ apiKeys: [{ apiKey: secret, createdAt }] });
      },
      { appId, apiKey: secret },
    );
    expect(
      await f.run(['apps', 'keys', 'delete', keyId(secret), '--app-id', appId]),
    ).toEqual({ appId, keyId: keyId(secret), deleted: true });
    const profile = (await f.storage.read()).profiles[profileKey]!;
    expect(profile.appId).toBe(appId);
    expect(profile.apiKey).toBeUndefined();
  });

  it('deletes an app and invalidates selection even when the delete response is lost', async () => {
    let fail = true;
    const f = await fixture(
      (url, options) => {
        expect(url.pathname).toBe(`/v1/apps/${appId}`);
        expect(options.method).toBe('DELETE');
        if (fail) throw new Error(secret);
        return json({}, 404);
      },
      { appId, apiKey: secret },
    );
    await expect(f.run(['apps', 'delete', appId])).rejects.toMatchObject({
      code: 'STUDIO_UNAVAILABLE',
    });
    const profile = (await f.storage.read()).profiles[profileKey]!;
    expect(profile.appId).toBeUndefined();
    expect(profile.apiKey).toBeUndefined();
    fail = false;
    expect(await f.run(['apps', 'delete', appId])).toEqual({
      appId,
      deleted: true,
    });
  });

  it('bounds repeated key pagination tokens without deleting an arbitrary key', async () => {
    const f = await fixture(() =>
      json({ pagination: { nextPageToken: 'repeat' } }),
    );
    await expect(
      f.studio.deleteKey(appId, keyId(secret)),
    ).rejects.toMatchObject({ code: 'STUDIO_INVALID_RESPONSE' });
    expect(
      f.fetcher.mock.calls.every(([, options]) => options?.method === 'GET'),
    ).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps accepted creation resumable when revealing the key fails', async () => {
    let failRead = true;
    const f = await fixture((_url, options) => {
      if (options.method === 'POST')
        return json({ apiKey: { apiKey: secret, createdAt } });
      if (failRead) throw new Error(secret);
      return json({ apiKeys: [{ apiKey: secret, createdAt }] });
    });
    await expect(
      f.studio.createKey({ appId, showSecrets: true }),
    ).rejects.toMatchObject({
      code: 'STUDIO_UNAVAILABLE',
      options: {
        details: { operationId: expect.any(String) },
        recovery: expect.stringContaining('--resume'),
      },
    });
    const id = String(f.events[0]!.operationId);
    expect(JSON.parse(await f.journal(id)).state).toBe('accepted');
    failRead = false;
    expect(
      await f.studio.createKey({ resume: id, showSecrets: true }),
    ).toMatchObject({ apiKey: secret });
    expect(
      f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
  });

  it.each([secret, 'synthetic-other-key'])(
    'clears only matching cached keys when the requested key is already absent: %s',
    async (cached) => {
      const f = await fixture(() => json({}), { appId, apiKey: cached });
      expect(await f.studio.deleteKey(appId, keyId(secret))).toEqual({
        appId,
        keyId: keyId(secret),
        deleted: true,
      });
      expect((await f.storage.read()).profiles[profileKey]!.apiKey).toBe(
        cached === secret ? undefined : cached,
      );
      expect(
        f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET'),
      ).toBe(true);
    },
  );

  it('lists public and custom Studio avatars with status arrays and pagination', async () => {
    const f = await fixture((url) => {
      if (url.pathname === '/v2/console/public-avatars')
        return json({
          publicAvatars: [{ id: 'public-id', name: 'Presenter' }],
          pagination: { nextPageToken: 'public-next' },
        });
      expect(url.pathname).toBe('/v2/console/custom-avatars');
      expect(url.searchParams.getAll('statuses')).toEqual([
        'CUSTOM_AVATAR_STATUS_SUCCESS',
        'CUSTOM_AVATAR_STATUS_GENERATING',
      ]);
      expect(url.searchParams.get('pagination.pageToken')).toBe('custom-next');
      return json({
        avatars: [
          {
            id: 'apply-id',
            applyId: 'apply-id',
            status: 'CUSTOM_AVATAR_STATUS_GENERATING',
          },
        ],
        counts: { all: 4, generating: 1 },
      });
    });
    expect(await f.run(['avatars', 'list', '--type', 'public'])).toEqual({
      type: 'public',
      avatars: [{ id: 'public-id', name: 'Presenter' }],
      pagination: { nextPageToken: 'public-next' },
    });
    expect(
      await f.run([
        'avatars',
        'list',
        '--status',
        'success,generating',
        '--page-token',
        'custom-next',
      ]),
    ).toMatchObject({
      type: 'custom',
      avatars: [{ applyId: 'apply-id' }],
      counts: { all: 4, generating: 1 },
    });
  });

  it('treats a key under an already deleted app as absent', async () => {
    const f = await fixture(() => json({}, 404), { appId, apiKey: secret });
    expect(await f.studio.deleteKey(appId, keyId(secret))).toEqual({
      appId,
      keyId: keyId(secret),
      deleted: true,
    });
    expect(
      (await f.storage.read()).profiles[profileKey]!.apiKey,
    ).toBeUndefined();
    expect(
      f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET'),
    ).toBe(true);
  });

  it.each([
    ['apps', 'session-tokens', 'create'],
    ['apps', 'session-tokens', 'create', '--app-id', appId, '--key-id', secret],
    ['apps', 'create'],
    ['apps', 'keys', 'create'],
    ['apps', 'keys', 'list'],
    ['apps', 'get', '..'],
    ['apps', 'keys', 'delete', secret, '--app-id', appId],
    ['avatars', 'list', '--page-size', '1.5'],
    ['avatars', 'list', '--page-size', '101'],
    ['avatars', 'list', '--status', 'succeeded'],
    ['avatars', 'list', '--type', 'public', '--status', 'success'],
    ['apps', 'create', '--name', 'Demo', '--resume', userId],
  ])('rejects invalid input before authentication: %j', async (...args) => {
    const f = await fixture(() => {
      throw new Error('Must not send');
    });
    await expect(f.run(args)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      options: { exitCode: 2 },
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('normalizes omitted empty lists and rejects malformed pagination', async () => {
    let malformed = false;
    const f = await fixture(() =>
      json(malformed ? { pagination: { nextPageToken: 3 } } : {}),
    );
    expect(await f.studio.listAvatars()).toEqual({
      type: 'custom',
      avatars: [],
      pagination: { nextPageToken: '' },
    });
    malformed = true;
    await expect(f.studio.listAvatars()).rejects.toMatchObject({
      code: 'STUDIO_INVALID_RESPONSE',
    });
  });
});
