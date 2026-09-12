import { createHash } from 'node:crypto';
import { env } from 'cloudflare:workers';
import {
  evictDurableObject,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PART_SIZE,
  INPUT_TTL_MS,
  type CreateUpload,
  type Upload,
} from '@spatius/contracts';
import worker, { testable } from '../src/index.js';
import { fileURL, verifyFileURL } from '../src/signing.js';
import { uploadLimits } from '../src/limits.js';
import type { UploadCoordinator } from '../src/coordinator.js';

const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
function png(size = 128): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
}
function audio(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('RIFFxxxxWAVE'));
  return bytes;
}
function input(
  bytes = png(),
  overrides: Partial<CreateUpload> = {},
): CreateUpload {
  return {
    requestId: crypto.randomUUID(),
    kind: 'avatar-image',
    contentType: 'image/png',
    size: bytes.length,
    sha256: hash(bytes),
    ...overrides,
  };
}
function request(
  path: string,
  init: RequestInit = {},
  owner = 'user-a',
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${owner}`);
  return worker.fetch(
    new Request(`https://media.example.test${path}`, { ...init, headers }),
    env,
  );
}
async function create(
  bytes = png(),
  overrides: Partial<CreateUpload> = {},
  owner = 'user-a',
): Promise<Upload> {
  const response = await request(
    '/v1/uploads',
    { method: 'POST', body: JSON.stringify(input(bytes, overrides)) },
    owner,
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json<Upload>();
}
async function part(
  upload: Upload,
  bytes: Uint8Array,
  number = 1,
  digest = hash(bytes),
  owner = 'user-a',
): Promise<Response> {
  return request(
    `/v1/uploads/${upload.id}/parts/${number}`,
    {
      method: 'PUT',
      body: bytes,
      headers: {
        'Content-Length': String(bytes.length),
        'x-content-sha256': digest,
      },
    },
    owner,
  );
}
async function finish(upload: Upload, bytes = png()): Promise<Upload> {
  expect((await part(upload, bytes)).status).toBe(200);
  const response = await request(`/v1/uploads/${upload.id}/complete`, {
    method: 'POST',
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json<Upload>();
}
function owner(): DurableObjectStub<UploadCoordinator> {
  return env.UPLOADS.getByName('user-a');
}
interface StoredRecord {
  id: string;
  status: string;
  deadline: number;
  uploadExpiresAt: number;
  expiresAt?: number;
  multipartId: string;
  parts: { number: number; etag: string }[];
  pending?: { deadline: number };
  [key: string]: unknown;
}
async function record(id: string): Promise<StoredRecord> {
  return runInDurableObject(
    owner(),
    (_instance, state) =>
      JSON.parse(
        state.storage.sql
          .exec<{ data: string }>('SELECT data FROM uploads WHERE id=?', id)
          .one().data,
      ) as StoredRecord,
  );
}
async function alter(
  id: string,
  fn: (value: StoredRecord) => void,
): Promise<void> {
  await runInDurableObject(owner(), (_instance, state) => {
    const row = JSON.parse(
      state.storage.sql
        .exec<{ data: string }>('SELECT data FROM uploads WHERE id=?', id)
        .one().data,
    ) as StoredRecord;
    fn(row);
    state.storage.sql.exec(
      'UPDATE uploads SET data=?,status=?,deadline=? WHERE id=?',
      JSON.stringify(row),
      row.status,
      row.deadline,
      id,
    );
  });
}
async function resetRate(): Promise<void> {
  await runInDurableObject(owner(), (_instance, state) => {
    state.storage.sql.exec('DELETE FROM rate_bucket');
  });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (resource, init) => {
    const url = resource instanceof Request ? resource.url : String(resource);
    expect(url).toBe('https://api.studio.spatius.ai/v1/auth/me');
    expect(init?.redirect).toBe('manual');
    // Exercise real workerd Request validation before providing the mocked response.
    new Request(resource, init);
    const token = new Headers(init?.headers)
      .get('authorization')
      ?.replace(/^Bearer /i, '');
    return Response.json({ user: { id: token } });
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await reset();
});

describe('Studio-authenticated media service', () => {
  it('requires Studio login and verifies the current identity on every management request', async () => {
    const unauthenticated = await worker.fetch(
      new Request('https://media.example.test/v1/uploads'),
      env,
    );
    expect(unauthenticated.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    const upload = await create();
    expect((await request(`/v1/uploads/${upload.id}`)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await request(`/v1/uploads/${upload.id}`)).status).toBe(401);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect((await request(`/v1/uploads/${upload.id}`)).status).toBe(503);
  });
  it('rejects malformed, redirected, and unavailable Studio identity responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ user: { id: '' } }));
    expect(
      (await request('/v1/uploads', { method: 'POST', body: '{}' })).status,
    ).toBe(503);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('redirect rejected'));
    expect(
      (await request('/v1/uploads', { method: 'POST', body: '{}' })).status,
    ).toBe(503);
  });
  it('isolates every upload operation by the authenticated user', async () => {
    const upload = await create();
    for (const [suffix, method] of [
      ['', 'GET'],
      ['', 'DELETE'],
      ['/complete', 'POST'],
      ['/parts/1', 'PUT'],
    ] as const) {
      const response = await request(
        `/v1/uploads/${upload.id}${suffix}`,
        {
          method,
          headers: { 'Content-Length': '128', 'x-content-sha256': hash(png()) },
        },
        'user-b',
      );
      expect(response.status).toBe(404);
    }
  });
  it('stores an immutable typed file and replays the exact completion URL across eviction', async () => {
    const upload = await create();
    const completed = await finish(upload);
    expect(completed.status).toBe('completed');
    expect(
      Date.parse(completed.expiresAt!) - Date.parse(completed.completedAt!),
    ).toBe(INPUT_TTL_MS);
    await evictDurableObject(owner());
    const repeated = await request(`/v1/uploads/${upload.id}/complete`, {
      method: 'POST',
    });
    expect((await repeated.json<Upload>()).url).toBe(completed.url);
    const beforeReads = vi.mocked(fetch).mock.calls.length;
    const download = await worker.fetch(new Request(completed.url!), env);
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Type')).toBe('image/png');
    expect(download.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(png());
    const head = await worker.fetch(
      new Request(completed.url!, { method: 'HEAD' }),
      env,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(vi.mocked(fetch).mock.calls.length).toBe(beforeReads);
    expect((await part(upload, png())).status).toBe(409);
    expect(
      (await request(`/v1/uploads/${upload.id}`, { method: 'DELETE' })).status,
    ).toBe(409);
  });
  it('deduplicates identical admission and rejects changed payloads without another reservation', async () => {
    const value = input();
    const calls = await Promise.all(
      Array.from({ length: 4 }, () =>
        request('/v1/uploads', { method: 'POST', body: JSON.stringify(value) }),
      ),
    );
    const uploads = await Promise.all(
      calls.map((response) => response.json<Upload>()),
    );
    expect(new Set(uploads.map((upload) => upload.id)).size).toBe(1);
    const conflict = await request('/v1/uploads', {
      method: 'POST',
      body: JSON.stringify({ ...value, sha256: 'a'.repeat(64) }),
    });
    expect(conflict.status).toBe(409);
    const totals = await runInDurableObject(
      owner(),
      (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>('SELECT COUNT(*) AS count FROM uploads')
          .one().count,
    );
    expect(totals).toBe(1);
  });
  it('rejects unsupported, empty, oversized, and malformed upload declarations', async () => {
    for (const overrides of [
      { size: 0 },
      { size: 5 * 1024 * 1024 + 1 },
      { contentType: 'image/webp' },
      { sha256: 'bad' },
      { requestId: 'bad' },
    ]) {
      const response = await request('/v1/uploads', {
        method: 'POST',
        body: JSON.stringify(input(png(), overrides)),
      });
      expect(response.status).toBe(400);
    }
    const huge = await request('/v1/uploads', {
      method: 'POST',
      body: JSON.stringify({ extra: 'x'.repeat(20000) }),
    });
    expect(huge.status).toBe(413);
  });
  it('enforces exact part lengths, required digest, and content signatures', async () => {
    const upload = await create();
    expect(
      (
        await request(`/v1/uploads/${upload.id}/parts/1`, {
          method: 'PUT',
          body: new ReadableStream({
            start(c) {
              c.enqueue(png());
              c.close();
            },
          }),
          headers: { 'x-content-sha256': hash(png()) },
        })
      ).status,
    ).toBe(411);
    expect(
      (
        await request(`/v1/uploads/${upload.id}/parts/1`, {
          method: 'PUT',
          body: png(),
          headers: { 'Content-Length': '128' },
        })
      ).status,
    ).toBe(400);
    expect((await part(upload, png(127))).status).toBe(400);
    const wrongDigest = await part(upload, png(), 1, '0'.repeat(64));
    expect(wrongDigest.status).toBe(400);
    expect(
      (await (await request(`/v1/uploads/${upload.id}`)).json<Upload>()).status,
    ).toBe('aborted');
    const unsupported = new Uint8Array(128);
    const another = await create(unsupported);
    expect((await part(another, unsupported)).status).toBe(400);
    expect(await env.MEDIA_BUCKET.head(`media/${another.id}`)).toBeNull();
  });
  it('verifies the complete file checksum rather than only its part checksums', async () => {
    const upload = await create(png(), { sha256: 'f'.repeat(64) });
    expect((await part(upload, png())).status).toBe(200);
    const response = await request(`/v1/uploads/${upload.id}/complete`, {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect(await env.MEDIA_BUCKET.head(`media/${upload.id}`)).toBeNull();
  });
});

describe('durable admission, parts, and cleanup', () => {
  it('atomically admits at most ten unfinished uploads', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 14 }, () => owner().create(input())),
    );
    expect(outcomes.filter((result) => result.ok)).toHaveLength(10);
    expect(
      outcomes.filter((result) => !result.ok && result.status === 429),
    ).toHaveLength(4);
  });
  it('reserves declared bytes and does not refund rolling-day admissions on abort', async () => {
    const bytes = 500 * 1024 * 1024;
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        owner().create(
          input(png(), {
            kind: 'audio',
            contentType: 'audio/wav',
            size: bytes,
          }),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(4);
    const first = outcomes[0];
    if (!first?.ok) throw new Error('missing upload');
    expect((await owner().abort(first.value.id)).ok).toBe(true);
    expect(
      (
        await owner().create(
          input(png(), {
            kind: 'audio',
            contentType: 'audio/wav',
            size: bytes,
          }),
        )
      ).ok,
    ).toBe(true);
    await runInDurableObject(owner(), (_instance, state) => {
      const row = state.storage.sql
        .exec<{ data: string }>('SELECT data FROM uploads LIMIT 1')
        .one();
      for (let index = 0; index < 95; index++) {
        const fakeId = crypto.randomUUID();
        state.storage.sql.exec(
          'INSERT INTO uploads(id,request_id,created_at,reserved,size,status,deadline,data) VALUES (?,?,?,0,0,?,0,?)',
          fakeId,
          fakeId,
          Date.now(),
          'aborted',
          row.data,
        );
      }
    });
    const denied = await owner().create(input());
    expect(denied.ok).toBe(false);
    if (!denied.ok)
      expect(denied.body.error.code).toBe('upload_quota_exceeded');
  });
  it('rate-limits operations with a burst of twenty', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => owner().rateLimit()),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(20);
    expect(
      results.filter((result) => !result.ok && result.status === 429),
    ).toHaveLength(5);
  });
  it('serializes part claims and recovers accepted parts after restart', async () => {
    const bytes = audio(PART_SIZE + 12);
    const upload = await create(bytes, {
      kind: 'audio',
      contentType: 'audio/wav',
    });
    const first = bytes.subarray(0, PART_SIZE);
    const claims = await Promise.all([
      owner().beginPart(upload.id, 1, hash(first), first.length),
      owner().beginPart(upload.id, 1, hash(first), first.length),
    ]);
    expect(claims.filter((result) => result.ok)).toHaveLength(1);
    const claim = claims.find((result) => result.ok);
    if (!claim?.ok) throw new Error('missing claim');
    const permit = claim.value;
    const request = new Request('https://media.example.test/part', {
      method: 'PUT',
      body: first,
    });
    const etag = await testable.streamPart(
      request,
      env,
      permit,
      1,
      hash(first),
    );
    expect(
      (await owner().finishPart(upload.id, permit.operationId!, etag)).ok,
    ).toBe(true);
    await evictDurableObject(owner());
    const after = await owner().status(upload.id);
    expect(after.ok && after.value.acceptedParts).toEqual([1]);
    const repeat = await owner().beginPart(
      upload.id,
      1,
      hash(first),
      first.length,
    );
    expect(repeat.ok && repeat.value.operationId).toBeUndefined();
    expect((await part(upload, bytes.subarray(PART_SIZE), 2)).status).toBe(200);
    const complete = await owner().complete(upload.id);
    expect(complete.ok && complete.value.status).toBe('completed');
  });
  it('rejects overflowing streams even when their declared Content-Length was accepted', async () => {
    const upload = await create();
    const result = await owner().beginPart(upload.id, 1, hash(png()), 128);
    if (!result.ok) throw new Error('missing claim');
    await expect(
      testable.streamPart(
        new Request('https://media.example.test/part', {
          method: 'PUT',
          body: png(129),
          headers: { 'Content-Length': '128' },
        }),
        env,
        result.value,
        1,
        hash(png()),
      ),
    ).rejects.toThrow('expected byte count');
    await owner().failPart(upload.id, result.value.operationId!);
  });
  it('aborts an ambiguous pending part instead of allowing a late writer to race a replacement', async () => {
    const upload = await create();
    const permit = await owner().beginPart(upload.id, 1, hash(png()), 128);
    if (!permit.ok) throw new Error('missing claim');
    await alter(upload.id, (value) => {
      value.deadline = Date.now() - 1;
      if (value.pending) value.pending.deadline = value.deadline;
    });
    await evictDurableObject(owner());
    await runDurableObjectAlarm(owner());
    const recovered = await owner().status(upload.id);
    expect(recovered.ok && recovered.value.status).toBe('aborted');
    expect(
      (
        await owner().finishPart(
          upload.id,
          permit.value.operationId!,
          'late-etag',
        )
      ).ok,
    ).toBe(false);
    await expect(
      env.MEDIA_BUCKET.resumeMultipartUpload(
        permit.value.key!,
        permit.value.multipartId!,
      ).uploadPart(1, png()),
    ).rejects.toThrow();
  });
  it('recovers R2 completion before the durable success response was saved', async () => {
    const upload = await create();
    expect((await part(upload, png())).status).toBe(200);
    await alter(upload.id, (value) => {
      value.status = 'finalizing';
    });
    const stored = await record(upload.id);
    const result = await env.MEDIA_BUCKET.resumeMultipartUpload(
      `media/${upload.id}`,
      stored.multipartId,
    ).complete(
      stored.parts.map((part) => ({
        partNumber: part.number,
        etag: part.etag,
      })),
    );
    await evictDurableObject(owner());
    const recovered = await owner().status(upload.id);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.status).toBe('completed');
      expect(recovered.value.completedAt).toBe(result.uploaded.toISOString());
      expect(Date.parse(recovered.value.expiresAt!)).toBe(
        result.uploaded.getTime() + INPUT_TTL_MS,
      );
    }
  });
  it('enforces signed link expiry before delayed lifecycle cleanup', async () => {
    const upload = await create();
    const completed = await finish(upload);
    const expired = await fileURL(env, upload.id, Date.now() - 1000);
    const response = await worker.fetch(new Request(expired), env);
    expect(response.status).toBe(410);
    expect(await env.MEDIA_BUCKET.head(`media/${upload.id}`)).not.toBeNull();
    const changed = new URL(completed.url!);
    changed.searchParams.set('expires', String(Date.now() + INPUT_TTL_MS * 2));
    expect((await worker.fetch(new Request(changed), env)).status).toBe(403);
    await expect(
      verifyFileURL(
        env,
        new URL(completed.url!),
        Date.parse(completed.expiresAt!),
      ),
    ).rejects.toThrow('expired');
    await alter(upload.id, (value) => {
      value.deadline = Date.now() - 1;
      value.expiresAt = value.deadline;
    });
    await runDurableObjectAlarm(owner());
    await runDurableObjectAlarm(owner());
    expect(await env.MEDIA_BUCKET.head(`media/${upload.id}`)).toBeNull();
    const saved = await owner().status(upload.id);
    expect(saved.ok && saved.value.status).toBe('expired');
  });
  it('retains quota and schedules cleanup again when R2 deletion fails', async () => {
    const upload = await create();
    await finish(upload);
    await alter(upload.id, (value) => {
      value.deadline = Date.now() - 1;
      value.expiresAt = value.deadline;
    });
    await runInDurableObject(owner(), async (instance, state) => {
      const deletion = vi
        .spyOn(env.MEDIA_BUCKET, 'delete')
        .mockRejectedValueOnce(new Error('temporary outage'));
      await instance.alarm();
      deletion.mockRestore();
      const value = state.storage.sql
        .exec<{ reserved: number; deadline: number }>(
          'SELECT reserved,deadline FROM uploads WHERE id=?',
          upload.id,
        )
        .one();
      expect(value.reserved).toBe(1);
      expect(value.deadline).toBeGreaterThan(Date.now());
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await resetRate();
  });
});

describe('configuration and recovery protections', () => {
  it('shares one file verification across concurrent completion and status requests', async () => {
    const upload = await create();
    expect((await part(upload, png())).status).toBe(200);
    // Keep deferred binding mocks in the Durable Object's I/O context. Passing a
    // promise created in a test request into another request crashes workerd.
    await runInDurableObject(owner(), async (instance) => {
      const original = env.MEDIA_BUCKET.get.bind(env.MEDIA_BUCKET);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const reads = vi
        .spyOn(env.MEDIA_BUCKET, 'get')
        .mockImplementation(async (...args) => {
          entered();
          await gate;
          return original(...args);
        });
      const first = instance.complete(upload.id);
      await started;
      const statuses = await Promise.all(
        Array.from({ length: 8 }, () => instance.status(upload.id)),
      );
      expect(
        statuses.every(
          (status) => status.ok && status.value.status === 'finalizing',
        ),
      ).toBe(true);
      const others = Array.from({ length: 8 }, () =>
        instance.complete(upload.id),
      );
      release();
      const completed = await Promise.all([first, ...others]);
      expect(
        completed.every(
          (result) => result.ok && result.value.status === 'completed',
        ),
      ).toBe(true);
      expect(reads).toHaveBeenCalledTimes(1);
      reads.mockRestore();
    });
  });
  it('fails closed on malformed configured allowances and uses configured limits', () => {
    const config = { ...env };
    expect(uploadLimits(config).maxBytes).toBe(2147483648);
    Reflect.set(config, 'MAX_STORED_BYTES', '512');
    expect(uploadLimits(config).maxBytes).toBe(512);
    for (const value of [
      '',
      '0',
      '-1',
      'NaN',
      'Infinity',
      '1.5',
      '9007199254740992',
    ]) {
      Reflect.set(config, 'MAX_STORED_BYTES', value);
      expect(() => uploadLimits(config)).toThrow('not configured');
    }
  });
  it('rejects unsafe public origins and supports only loopback plain HTTP', async () => {
    const config = { ...env };
    for (const value of [
      'http://example.com',
      'https://example.com?token=bad',
      'https://example.com#fragment',
      'https://name:password@example.com',
    ]) {
      Reflect.set(config, 'PUBLIC_URL', value);
      await expect(
        fileURL(config, crypto.randomUUID(), Date.now() + 3600000),
      ).rejects.toThrow('not configured');
    }
    Reflect.set(config, 'PUBLIC_URL', 'http://localhost:8787');
    expect(
      await fileURL(config, crypto.randomUUID(), Date.now() + 3600000),
    ).toMatch(/^http:\/\/localhost:8787/);
  });
  it('rejects an error envelope even if it includes an apparent user identity', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        user: { id: 'user-a' },
        error: { code: 'invalid_token' },
      }),
    );
    expect(
      (await request('/v1/uploads', { method: 'POST', body: '{}' })).status,
    ).toBe(503);
  });
  it('enforces the five-second authentication deadline without logging the credential', async () => {
    vi.useFakeTimers();
    const warnings = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    vi.mocked(fetch).mockImplementation(
      (_request, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('upstream-secret-must-not-appear')),
          );
        }),
    );
    const response = request(
      '/v1/uploads',
      { method: 'POST', body: '{}' },
      'sensitive-studio-login-token',
    );
    await vi.advanceTimersByTimeAsync(5001);
    expect((await response).status).toBe(503);
    const logs = JSON.stringify(warnings.mock.calls);
    expect(logs).toContain('media_operation_failed');
    expect(logs).toContain('media_auth_failed');
    expect(logs).toContain('timeout');
    expect(logs).not.toContain('sensitive-studio-login-token');
    expect(logs).not.toContain('upstream-secret-must-not-appear');
  });
});

it('coalesces completion through concurrent real Durable Object RPC calls', async () => {
  const bytes = audio(PART_SIZE);
  const upload = await create(bytes, {
    kind: 'audio',
    contentType: 'audio/wav',
  });
  expect((await part(upload, bytes)).status).toBe(200);
  const completed = await Promise.all(
    Array.from({ length: 8 }, () => owner().complete(upload.id)),
  );
  expect(
    completed.every((value) => value.ok && value.value.status === 'completed'),
  ).toBe(true);
  expect(
    new Set(completed.map((value) => (value.ok ? value.value.url : ''))).size,
  ).toBe(1);
});

it('logs controlled authentication failure diagnostics without upstream content', async () => {
  const warnings = vi
    .spyOn(console, 'warn')
    .mockImplementation(() => undefined);
  const cases: {
    response?: Response;
    error?: Error;
    reason: string;
    phase: string;
    status?: number;
    contentType?: string;
  }[] = [
    {
      error: new TypeError('PRIVATE-TOKEN network failure'),
      reason: 'network',
      phase: 'request',
    },
    {
      response: new Response('PRIVATE-TOKEN html failure', {
        status: 502,
        headers: { 'Content-Type': 'text/html; secret=PRIVATE-TOKEN' },
      }),
      reason: 'status',
      phase: 'request',
      status: 502,
      contentType: 'html',
    },
    {
      response: new Response('PRIVATE-TOKEN invalid json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      reason: 'invalid_json',
      phase: 'body',
      status: 200,
      contentType: 'json',
    },
    {
      response: Response.json({ user: { email: 'PRIVATE-TOKEN' } }),
      reason: 'identity',
      phase: 'identity',
      status: 200,
      contentType: 'json',
    },
  ];
  for (const item of cases) {
    warnings.mockClear();
    if (item.error) vi.mocked(fetch).mockRejectedValueOnce(item.error);
    else vi.mocked(fetch).mockResolvedValueOnce(item.response!);
    expect(
      (
        await request(
          '/v1/uploads',
          { method: 'POST', body: '{}' },
          'PRIVATE-TOKEN',
        )
      ).status,
    ).toBe(503);
    const diagnostics = warnings.mock.calls
      .map(([text]) => JSON.parse(String(text)) as Record<string, unknown>)
      .find((entry) => entry.event === 'media_auth_failed');
    expect(diagnostics).toMatchObject({
      reason: item.reason,
      phase: item.phase,
      elapsedMs: expect.any(Number),
    });
    if (item.status) expect(diagnostics?.upstreamStatus).toBe(item.status);
    if (item.contentType)
      expect(diagnostics?.upstreamContentType).toBe(item.contentType);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('PRIVATE-TOKEN');
  }
});
