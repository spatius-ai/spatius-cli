import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PART_SIZE, type Upload } from '@spatius/contracts';
import { Workflows } from '../src/workflows/index.js';
import { CliError } from '../src/core/errors.js';

const ID = '00000000-0000-4000-8000-000000000001';
const UPLOAD_ID = '00000000-0000-4000-8000-000000000002';
const AVATAR_ID = '00000000-0000-4000-8000-000000000003';
const consoleOrigin = 'https://console.example.test';
const mediaOrigin = 'https://media.example.test';
const audioUrl =
  'https://source.example.test/speech.wav?signature=private-input';
const created = {
  jobId: ID,
  status: 'queued',
  createdAt: '2026-09-12T00:00:00Z',
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const wav = (size = 100) => {
  const data = Buffer.alloc(size);
  data.write('RIFF', 0);
  data.write('WAVE', 8);
  return data;
};
let directory: string;
function makeAuth() {
  return {
    accessToken: vi.fn(async () => 'studio-secret'),
    credentials: vi.fn(async () => ({
      appId: 'app-example',
      apiKey: 'api-secret',
    })),
    identity: vi.fn(async () => ({
      userId: 'user-example',
      profileKey: 'profile-example',
    })),
    stateDirectory: () => directory,
  };
}
let auth: ReturnType<typeof makeAuth>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spatius-workflows-'));
  auth = makeAuth();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function workflows(send: typeof fetch, progress?: (event: unknown) => void) {
  return new Workflows({
    auth,
    consoleOrigin,
    mediaOrigin,
    fetch: send,
    onProgress: progress,
  });
}
async function journals() {
  const path = join(directory, 'operations', 'profile-example');
  return Promise.all(
    (await readdir(path))
      .filter((p) => p.endsWith('.json'))
      .map(async (p) => JSON.parse(await readFile(join(path, p), 'utf8'))),
  );
}
function uploadFor(body: {
  requestId: string;
  size: number;
  sha256: string;
  kind: string;
  contentType: string;
}): Upload {
  return {
    id: UPLOAD_ID,
    ...body,
    kind: body.kind as 'audio',
    status: 'uploading',
    partSize: PART_SIZE,
    partCount: Math.ceil(body.size / PART_SIZE),
    acceptedParts: [],
    createdAt: new Date().toISOString(),
    uploadExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

describe('creation recovery', () => {
  it('preserves the HTTP request ID when adding creation recovery metadata', async () => {
    const send = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { code: 'permission_denied' } }), {
          status: 403,
          headers: { 'x-request-id': 'request_trace_123' },
        }),
    );
    await expect(
      workflows(send).createVideo({ avatarId: AVATAR_ID, audio: audioUrl }),
    ).rejects.toMatchObject({
      code: 'permission_denied',
      options: {
        details: {
          requestId: 'request_trace_123',
          operationId: expect.any(String),
        },
      },
    });
  });
  it('preserves terminal job identity and status when creation waits for completion', async () => {
    const send = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/videos')
        ? json(created)
        : json({
            job: {
              id: ID,
              status: 'failed',
              error: {
                code: 'RENDER_FAILED',
                message: 'Render failed.',
                retryable: false,
              },
            },
          }),
    );
    await expect(
      workflows(send).createVideo({
        avatarId: AVATAR_ID,
        audio: audioUrl,
        wait: true,
      }),
    ).rejects.toMatchObject({
      code: 'RENDER_FAILED',
      options: {
        details: {
          jobId: ID,
          status: 'failed',
          operationId: expect.any(String),
        },
      },
    });
  });
  it('journals the exact video payload before POST and retries a lost response with unchanged identity and URLs', async () => {
    const bodies: string[] = [];
    const send = vi.fn<typeof fetch>(async (url, options) => {
      expect(String(url)).toBe(`${consoleOrigin}/v1/open/videos`);
      expect(options?.headers).toMatchObject({
        'x-app-id': 'app-example',
        'x-api-key': 'api-secret',
      });
      expect(options?.redirect).toBe('error');
      const [record] = await journals();
      expect(record.state).toBe('submitting');
      expect(record.body).toEqual(JSON.parse(options?.body as string));
      bodies.push(options?.body as string);
      if (bodies.length === 1)
        throw new TypeError('network failed with api-secret');
      return json(created);
    });
    const result = (await workflows(send).createVideo({
      avatarId: AVATAR_ID,
      audio: audioUrl,
    })) as typeof created & { operationId: string };
    expect(result.jobId).toBe(ID);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!).requestId).toMatch(/^[0-9a-f-]{36}$/);
    const file = join(
      directory,
      'operations',
      'profile-example',
      `${result.operationId}.json`,
    );
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).not.toContain('api-secret');
    const resumed = await workflows(send).createVideo({
      resume: result.operationId,
      video: {},
    });
    expect(resumed).toEqual(result);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('never automatically resubmits an uncertain Avatar creation', async () => {
    const send = vi.fn<typeof fetch>(async () => {
      throw new TypeError('response lost');
    });
    const flow = workflows(send);
    let failure: CliError | undefined;
    try {
      await flow.createAvatar({
        image: 'https://source.example.test/image.png',
      });
    } catch (error) {
      failure = error as CliError;
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(failure?.code).toBe('SUBMISSION_UNCERTAIN');
    expect(failure?.options.details).toHaveProperty('operationId');
    const id = (failure!.options.details as { operationId: string })
      .operationId;
    await expect(flow.createAvatar({ resume: id })).rejects.toMatchObject({
      code: 'SUBMISSION_UNCERTAIN',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('keeps identical input after an uncertain request and refuses expired temporary sources', async () => {
    const send = vi.fn<typeof fetch>(async () =>
      json({ error: { code: 'conflict' } }, 409),
    );
    const flow = workflows(send);
    await expect(
      flow.createVideo({ avatarId: AVATAR_ID, audio: audioUrl }),
    ).rejects.toBeInstanceOf(CliError);
    const [journal] = await journals();
    journal.state = 'submitting';
    journal.inputs.audioUrl.expiresAt = new Date(Date.now() - 1).toISOString();
    await writeFile(
      join(directory, 'operations', 'profile-example', `${journal.id}.json`),
      JSON.stringify(journal),
    );
    await expect(
      flow.createVideo({ resume: journal.id }),
    ).rejects.toMatchObject({ code: 'SOURCE_EXPIRED' });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(
      flow.createVideo({
        resume: journal.id,
        audio: 'https://different.test/audio.mp3',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
  it('allows a definitively rejected Avatar admission to resume after access is restored', async () => {
    let permitted = false;
    const send = vi.fn<typeof fetch>(async () =>
      permitted
        ? json(created)
        : json({ error: { code: 'permission_denied' } }, 403),
    );
    const flow = workflows(send);
    await expect(
      flow.createAvatar({ image: 'https://source.example.test/avatar.png' }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    const [saved] = await journals();
    expect(saved.state).toBe('ready');
    permitted = true;
    expect(await flow.createAvatar({ resume: saved.id })).toMatchObject({
      jobId: ID,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('reuses uploaded local inputs for an explicit request ID and rejects different payloads before upload', async () => {
    const file = join(directory, 'speech.wav');
    await writeFile(file, wav());
    let remote: Upload;
    const send = vi.fn<typeof fetch>(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/uploads') {
        remote = uploadFor(JSON.parse(options?.body as string));
        return json(remote);
      }
      if (path.includes('/parts/')) {
        remote!.acceptedParts = [1];
        return json(remote!);
      }
      if (path.endsWith('/complete'))
        return json({
          ...remote!,
          status: 'completed',
          url: 'https://media.example.test/files/immutable',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      if (path === '/v1/open/videos') return json(created);
      throw new Error('Unexpected request');
    });
    const flow = workflows(send);
    const first = await flow.createVideo({
      avatarId: AVATAR_ID,
      audio: file,
      requestId: ID,
    });
    const count = send.mock.calls.length;
    expect(
      await flow.createVideo({
        avatarId: AVATAR_ID,
        audio: file,
        requestId: ID,
      }),
    ).toEqual(first);
    expect(send).toHaveBeenCalledTimes(count);
    await writeFile(file, wav(101));
    await expect(
      flow.createVideo({ avatarId: AVATAR_ID, audio: file, requestId: ID }),
    ).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
    expect(send).toHaveBeenCalledTimes(count);
  });
  it('returns long rate-limit delays to the caller instead of sleeping without bound', async () => {
    const send = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { code: 'rate_limited' } }), {
          status: 429,
          headers: { 'retry-after': '86400' },
        }),
    );
    await expect(
      workflows(send).createVideo({ avatarId: AVATAR_ID, audio: audioUrl }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      options: { retryAfter: 86400 },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects another app or account when resuming', async () => {
    const send = vi.fn<typeof fetch>(async () => json(created));
    const result = (await workflows(send).createVideo({
      avatarId: AVATAR_ID,
      audio: audioUrl,
    })) as { operationId: string };
    auth.credentials.mockResolvedValue({
      appId: 'other-app',
      apiKey: 'other-key',
    });
    await expect(
      workflows(send).createVideo({ resume: result.operationId }),
    ).rejects.toMatchObject({ code: 'OPERATION_SCOPE_MISMATCH' });
    auth.identity.mockResolvedValue({
      userId: 'other-user',
      profileKey: 'other-profile',
    });
    await expect(
      workflows(send).createVideo({ resume: result.operationId }),
    ).rejects.toMatchObject({ code: 'OPERATION_NOT_FOUND' });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('validates dry runs without auth, network, upload, or journal changes', async () => {
    const file = join(directory, 'speech.wav');
    await writeFile(file, wav());
    const send = vi.fn<typeof fetch>();
    const result = (await workflows(send).createVideo({
      avatarId: AVATAR_ID,
      audio: file,
      dryRun: true,
    })) as { dryRun: boolean; inputs: unknown };
    expect(result.dryRun).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(auth.identity).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(['speech.wav']);
    await expect(
      workflows(send).createVideo({
        avatarId: AVATAR_ID,
        audio: file,
        video: { width: 101 },
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      workflows(send).createVideo({
        avatarId: AVATAR_ID,
        audio: 'https://user:secret@example.test/a.wav',
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('temporary uploads', () => {
  it('streams bounded sequential chunks with exact length and SHA-256 headers, then persists the completed URL', async () => {
    const file = join(directory, 'large.wav');
    const bytes = wav(PART_SIZE + 21);
    await writeFile(file, bytes);
    let remote: Upload;
    const parts: Uint8Array[] = [];
    const send = vi.fn<typeof fetch>(async (url, options) => {
      const path = new URL(String(url)).pathname;
      expect(options?.headers).toMatchObject({
        authorization: 'Bearer studio-secret',
      });
      if (path === '/v1/uploads') {
        remote = uploadFor(JSON.parse(options?.body as string));
        return json(remote);
      }
      if (path.includes('/parts/')) {
        const chunk = options?.body as Uint8Array;
        const number = Number(path.split('/').at(-1));
        expect(number).toBe(parts.length + 1);
        expect(options?.headers).toMatchObject({
          'content-length': String(chunk.byteLength),
          'x-content-sha256': createHash('sha256').update(chunk).digest('hex'),
        });
        parts.push(chunk);
        remote!.acceptedParts.push(number);
        return json(remote);
      }
      if (path.endsWith('/complete')) {
        remote!.status = 'completed';
        remote!.url = 'https://media.example.test/files/input?sig=private';
        remote!.expiresAt = new Date(Date.now() + 86_400_000).toISOString();
        return json(remote);
      }
      return json(remote!);
    });
    const flow = workflows(send);
    const result = await flow.upload(file, { kind: 'audio' });
    expect(parts.map((p) => p.byteLength)).toEqual([PART_SIZE, 21]);
    expect(Buffer.concat(parts).equals(bytes)).toBe(true);
    expect(result.status).toBe('completed');
    const resumed = await flow.upload(file, {
      kind: 'audio',
      resume: result.operationId,
    });
    expect(resumed.url).toBe(result.url);
    expect(parts).toHaveLength(2);
    expect((await journals())[0].file.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });
  it('can resume an upload ID without a local upload journal and skips accepted parts', async () => {
    const file = join(directory, 'speech.wav');
    const bytes = wav();
    await writeFile(file, bytes);
    const remote = uploadFor({
      requestId: ID,
      kind: 'audio',
      contentType: 'audio/wav',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    remote.acceptedParts = [1];
    const send = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith('/complete'))
        return json({
          ...remote,
          status: 'completed',
          url: 'https://media.example.test/files/a',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      expect(options?.method).toBe('GET');
      return json(remote);
    });
    const result = await workflows(send).upload(file, {
      kind: 'audio',
      resume: UPLOAD_ID,
    });
    expect(result.status).toBe('completed');
    expect(
      send.mock.calls.every(([, options]) => options?.method !== 'PUT'),
    ).toBe(true);
  });
  it('polls delayed initialization with the original upload ID before sending parts', async () => {
    const file = join(directory, 'speech.wav');
    await writeFile(file, wav());
    let remote: Upload;
    const calls: string[] = [];
    const send = vi.fn<typeof fetch>(async (url, options) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${options?.method} ${path}`);
      if (path === '/v1/uploads') {
        remote = {
          ...uploadFor(JSON.parse(options?.body as string)),
          status: 'initializing',
        };
        return json(remote);
      }
      if (options?.method === 'GET') {
        remote!.status = 'uploading';
        return json(remote!);
      }
      if (path.includes('/parts/')) {
        expect(remote!.status).toBe('uploading');
        remote!.acceptedParts = [1];
        return json(remote!);
      }
      if (path.endsWith('/complete'))
        return json({
          ...remote!,
          status: 'completed',
          url: `${mediaOrigin}/v1/files/${UPLOAD_ID}`,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
      throw new Error('Unexpected request');
    });
    const result = await workflows(send).upload(file, { kind: 'audio' });
    expect(result.status).toBe('completed');
    expect(calls).toEqual([
      'POST /v1/uploads',
      `GET /v1/uploads/${UPLOAD_ID}`,
      `PUT /v1/uploads/${UPLOAD_ID}/parts/1`,
      `POST /v1/uploads/${UPLOAD_ID}/complete`,
    ]);
  });
  it('polls finalizing uploads to completion without resending parts or completion', async () => {
    const file = join(directory, 'speech.wav');
    const bytes = wav();
    await writeFile(file, bytes);
    const remote = {
      ...uploadFor({
        requestId: ID,
        kind: 'audio',
        contentType: 'audio/wav',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
      status: 'finalizing' as const,
      acceptedParts: [1],
    };
    let reads = 0;
    const send = vi.fn<typeof fetch>(async (_url, options) => {
      expect(options?.method).toBe('GET');
      reads++;
      return json(
        reads <= 2
          ? remote
          : {
              ...remote,
              status: 'completed',
              url: `${mediaOrigin}/v1/files/${UPLOAD_ID}`,
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
      );
    });
    const result = await workflows(send).upload(file, {
      kind: 'audio',
      resume: UPLOAD_ID,
    });
    expect(result.status).toBe('completed');
    expect(reads).toBe(3);
  });
  it('stops initialization polling when its transfer lifetime expires', async () => {
    const file = join(directory, 'speech.wav');
    await writeFile(file, wav());
    const send = vi.fn<typeof fetch>(async (_url, options) =>
      json({
        ...uploadFor(JSON.parse(options?.body as string)),
        status: 'initializing',
        uploadExpiresAt: new Date(Date.now() + 25).toISOString(),
      }),
    );
    await expect(
      workflows(send).upload(file, { kind: 'audio' }),
    ).rejects.toMatchObject({
      code: 'UPLOAD_EXPIRED',
      options: { details: { operationId: expect.any(String) } },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('interrupts initialization polling while preserving its resume handle', async () => {
    const file = join(directory, 'speech.wav');
    await writeFile(file, wav());
    const controller = new AbortController();
    const send = vi.fn<typeof fetch>(async (_url, options) => {
      setTimeout(() => controller.abort(), 20);
      return json({
        ...uploadFor(JSON.parse(options?.body as string)),
        status: 'initializing',
      });
    });
    const flow = new Workflows({
      auth,
      consoleOrigin,
      mediaOrigin,
      fetch: send,
      signal: controller.signal,
    });
    await expect(flow.upload(file, { kind: 'audio' })).rejects.toMatchObject({
      code: 'INTERRUPTED',
      options: { exitCode: 130, details: { operationId: expect.any(String) } },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([
    'not-a-url',
    'https://unrelated.example.test/file',
    'http://media.example.test/file',
  ])('rejects unusable or foreign completed upload URLs: %s', async (url) => {
    const file = join(directory, 'speech.wav');
    await writeFile(file, wav());
    const send = vi.fn<typeof fetch>(async (_url, options) =>
      json({
        ...uploadFor(JSON.parse(options?.body as string)),
        status: 'completed',
        url,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    );
    await expect(
      workflows(send).upload(file, { kind: 'audio' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('refuses changed bytes on resume before making a request', async () => {
    const file = join(directory, 'speech.wav');
    await writeFile(file, wav());
    const send = vi.fn<typeof fetch>(async () => {
      throw new TypeError('lost response');
    });
    let failure: CliError | undefined;
    try {
      await workflows(send).upload(file, { kind: 'audio' });
    } catch (error) {
      failure = error as CliError;
    }
    const id = (failure!.options.details as { operationId: string })
      .operationId;
    await writeFile(file, wav(101));
    await expect(
      workflows(send).upload(file, { kind: 'audio', resume: id }),
    ).rejects.toMatchObject({ code: 'INPUT_CHANGED' });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects empty, unsupported, and oversized media before uploading', async () => {
    const file = join(directory, 'bad.wav');
    const send = vi.fn<typeof fetch>();
    await writeFile(file, Buffer.alloc(0));
    await expect(
      workflows(send).upload(file, { kind: 'audio' }),
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA' });
    await writeFile(file, 'not audio');
    await expect(
      workflows(send).upload(file, { kind: 'audio' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    await writeFile(file, Buffer.alloc(6 * 1024 * 1024));
    await expect(
      workflows(send).upload(file, { kind: 'avatar-image' }),
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('job polling and downloads', () => {
  it('preserves stable terminal failure information and never submits another render', async () => {
    const send = vi.fn<typeof fetch>(async () =>
      json({
        job: {
          id: ID,
          status: 'failed',
          error: {
            code: 'SESSION_TOKEN_EXPIRED',
            message: 'Session expired.',
            retryable: true,
          },
        },
      }),
    );
    await expect(workflows(send).waitJob('video', ID)).rejects.toMatchObject({
      code: 'SESSION_TOKEN_EXPIRED',
      options: { retryable: true },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]?.method).toBe('GET');
  });
  it('ends a wait with the saved job ID and a valid resume command', async () => {
    const send = vi.fn<typeof fetch>(async () =>
      json({ job: { id: ID, status: 'processing' } }),
    );
    await expect(
      workflows(send).waitJob('video', ID, { timeout: 0.02 }),
    ).rejects.toMatchObject({
      code: 'WAIT_TIMEOUT',
      options: {
        exitCode: 3,
        details: { jobId: ID },
        recovery: expect.stringContaining(`spatius videos wait ${ID}`),
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('preserves existing pagination conventions including repeated statuses', async () => {
    const send = vi.fn<typeof fetch>(async () =>
      json({ jobs: [], pagination: {} }),
    );
    await workflows(send).listJobs('video', {
      pageSize: 20,
      pageToken: 'a+b/c',
      statuses: ['queued', 'processing'],
    });
    const url = new URL(String(send.mock.calls[0]![0]));
    expect(url.searchParams.get('pagination.pageSize')).toBe('20');
    expect(url.searchParams.get('pagination.pageToken')).toBe('a+b/c');
    expect(url.searchParams.getAll('statuses')).toEqual([
      'queued',
      'processing',
    ]);
  });
  it('refreshes links on every download, sends no credentials to storage, and writes atomically', async () => {
    const output = join(directory, 'video.mp4');
    const bytes = Buffer.from('mp4 fixture');
    const send = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).includes('/v1/open/'))
        return json({
          job: { id: ID, status: 'succeeded' },
          videoUrl: 'https://storage.example.test/video.mp4?signature=private',
        });
      expect(options?.headers).toBeUndefined();
      expect(options?.redirect).toBe('error');
      return new Response(bytes, { headers: { 'content-type': 'video/mp4' } });
    });
    expect(await workflows(send).download(ID, { output })).toMatchObject({
      jobId: ID,
      output,
      bytes: bytes.length,
    });
    expect(await readFile(output)).toEqual(bytes);
    expect(await readdir(directory)).toEqual(['video.mp4']);
    await expect(
      workflows(send).download(ID, { output }),
    ).rejects.toMatchObject({ code: 'OUTPUT_EXISTS' });
    await workflows(send).download(ID, { output, force: true });
    expect(
      send.mock.calls.filter(([url]) => String(url).includes('/v1/open/')),
    ).toHaveLength(2);
  });
  it('rejects signed output redirects as retryable availability failures without following or forwarding credentials', async () => {
    const output = join(directory, 'video.mp4');
    const send = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).includes('/v1/open/'))
        return json({
          job: { id: ID, status: 'succeeded' },
          videoUrl: 'https://storage.example.test/result?signature=secret',
        });
      expect(options?.headers).toBeUndefined();
      expect(options?.redirect).toBe('error');
      throw new TypeError('fetch failed: unexpected redirect');
    });
    await expect(
      workflows(send).download(ID, { output }),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_UNAVAILABLE',
      options: { retryable: true },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await readdir(directory)).toEqual([]);
  });
  it.each(['http://storage.example.test/result', 'http://127.0.0.1/internal'])(
    'rejects insecure production output URLs before download: %s',
    async (videoUrl) => {
      const send = vi.fn<typeof fetch>(async () =>
        json({ job: { id: ID, status: 'succeeded' }, videoUrl }),
      );
      await expect(
        workflows(send).download(ID, { output: join(directory, 'video.mp4') }),
      ).rejects.toMatchObject({ code: 'DOWNLOAD_UNAVAILABLE' });
      expect(send).toHaveBeenCalledTimes(1);
      expect(await readdir(directory)).toEqual([]);
    },
  );
  it('cleans partial downloads and preserves the previous output on stream failure', async () => {
    const output = join(directory, 'video.mp4');
    await writeFile(output, 'original');
    const send = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('/v1/open/')
        ? json({
            job: { id: ID, status: 'succeeded' },
            videoUrl: 'https://storage.example.test/result',
          })
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(Buffer.from('partial'));
                controller.error(new Error('broken'));
              },
            }),
          ),
    );
    await expect(
      workflows(send).download(ID, { output, force: true }),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(await readFile(output, 'utf8')).toBe('original');
    expect(await readdir(directory)).toEqual(['video.mp4']);
  });
});
