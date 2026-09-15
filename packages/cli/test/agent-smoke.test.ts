import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  PART_SIZE,
  type CreateUpload,
  type JobStatus,
  type Upload,
} from '@spatius/contracts';
import { expect, it } from 'vitest';
import { AuthStorage } from '../src/auth/storage.js';

const userId = '10000000-0000-4000-8000-000000000001';
const avatarJobId = '10000000-0000-4000-8000-000000000002';
const avatarId = '10000000-0000-4000-8000-000000000003';
const videoJobId = '10000000-0000-4000-8000-000000000004';
const failedJobId = '10000000-0000-4000-8000-000000000005';
const expiredJobId = '10000000-0000-4000-8000-000000000006';
const appId = 'app_agent_smoke';
const secrets = [
  'synthetic-smoke-access',
  'synthetic-smoke-refresh',
  'synthetic-smoke-api-key',
];
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const packageDirectory = fileURLToPath(new URL('../', import.meta.url));

interface Failure {
  code: string;
  retryable: boolean;
  recovery?: string;
  details?: { operationId?: string; jobId?: string };
}
interface Result<T> {
  code: number | null;
  data?: T;
  error?: Failure;
  events: Array<Record<string, unknown>>;
}

// Valid, opaque 340px PNG and PCM WAV fixtures. Face detection, speech synthesis,
// and video encoding belong to the real services and are deliberately mocked.
function portrait() {
  const size = 340;
  const pixels = Buffer.alloc((1 + size * 3) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const face = (x - 170) ** 2 / 95 ** 2 + (y - 160) ** 2 / 120 ** 2 < 1;
      const eye =
        (x - 137) ** 2 + (y - 135) ** 2 < 8 ** 2 ||
        (x - 203) ** 2 + (y - 135) ** 2 < 8 ** 2;
      const mouth = y > 205 && y < 212 && x > 138 && x < 202;
      const offset = y * (1 + size * 3) + 1 + x * 3;
      pixels.set(
        eye || mouth ? [30, 30, 30] : face ? [230, 180, 130] : [220, 235, 245],
        offset,
      );
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    bytes.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function speech() {
  const samples = 800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++)
    bytes.writeInt16LE(
      Math.round(Math.sin(index * 0.2) * 1000),
      44 + index * 2,
    );
  return bytes;
}

it('lets an agent follow setup → local portrait → interrupted video → retained MP4 using the real CLI parser', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'spatius-agent-smoke-'));
  const configDir = join(directory, 'private-config');
  const imagePath = join(directory, 'portrait.png');
  const audioPath = join(directory, 'speech.wav');
  const output = join(directory, 'video.mp4');
  const imageBytes = portrait();
  const audioBytes = speech();
  const mp4Bytes = Buffer.from(
    '000000186674797069736f6d0000020069736f6d69736f32000000186d64617473796e7468657469632d6f7574707574',
    'hex',
  );
  await Promise.all([
    writeFile(imagePath, imageBytes),
    writeFile(audioPath, audioBytes),
  ]);
  const uploads = new Map<string, { upload: Upload; bytes?: Buffer }>();
  const mutations: string[] = [];
  const videoBodies: string[] = [];
  const serverFailures: unknown[] = [];
  const transcript: string[] = [];
  const createdAt = new Date().toISOString();
  const retainedUntil = new Date(Date.now() + 7 * 86400_000).toISOString();
  let appCreated = false;
  let keyCreated = false;
  let videoStatus: JobStatus = 'processing';
  let downloadLinks = 0;
  let downloads = 0;
  let rejectDownload = true;
  let interruptAdmission: (() => void) | undefined;
  let origin = '';
  const app = () => ({
    appId,
    name: 'Spatius CLI',
    createdAt,
    apiKeys: keyCreated ? [{ apiKey: secrets[2], createdAt }] : [],
  });
  const respond = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url!, origin);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = () => JSON.parse(bytes.toString('utf8'));
    if (request.method !== 'GET')
      mutations.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/output.mp4') {
      downloads++;
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers['x-api-key']).toBeUndefined();
      expect(url.searchParams.get('link')).toBe(String(downloadLinks));
      if (rejectDownload) {
        rejectDownload = false;
        return respond(response, { error: { message: secrets[2] } }, 403);
      }
      response.writeHead(200, { 'content-type': 'video/mp4' });
      response.end(mp4Bytes);
      return;
    }
    if (url.pathname.startsWith('/v1/open/')) {
      expect(request.headers['x-app-id']).toBe(appId);
      expect(request.headers['x-api-key']).toBe(secrets[2]);
      expect(request.headers.authorization).toBeUndefined();
    } else {
      expect(request.headers.authorization).toBe(`Bearer ${secrets[0]}`);
      expect(request.headers['x-api-key']).toBeUndefined();
    }
    if (url.pathname === '/v1/auth/me')
      return respond(response, { user: { id: userId } });
    if (url.pathname === '/v1/apps') {
      if (request.method === 'POST') {
        expect(body()).toEqual({ name: 'Spatius CLI' });
        appCreated = true;
        return respond(response, { appId });
      }
      return respond(response, {
        apps: appCreated ? [app()] : [],
        pagination: {},
      });
    }
    if (url.pathname === `/v1/apps/${appId}/api-keys`) {
      expect(body()).toEqual({ appId });
      keyCreated = true;
      return respond(response, { apiKey: { apiKey: secrets[2], createdAt } });
    }
    if (url.pathname === `/v1/apps/${appId}`)
      return respond(response, { app: app() });
    if (url.pathname === '/v1/uploads') {
      const input = body() as CreateUpload;
      const expected = input.kind === 'avatar-image' ? imageBytes : audioBytes;
      expect(input.size).toBe(expected.length);
      expect(input.sha256).toBe(hash(expected));
      expect(input.contentType).toBe(
        input.kind === 'avatar-image' ? 'image/png' : 'audio/wav',
      );
      const upload: Upload = {
        ...input,
        id: randomUUID(),
        status: 'uploading',
        partSize: PART_SIZE,
        partCount: 1,
        acceptedParts: [],
        createdAt,
        uploadExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
      uploads.set(upload.id, { upload });
      return respond(response, upload);
    }
    const uploadPath = /^\/v1\/uploads\/([^/]+)(\/parts\/1|\/complete)?$/.exec(
      url.pathname,
    );
    if (uploadPath) {
      const record = uploads.get(uploadPath[1]!)!;
      expect(record).toBeDefined();
      if (uploadPath[2] === '/parts/1') {
        expect(hash(bytes)).toBe(record.upload.sha256);
        expect(request.headers['x-content-sha256']).toBe(record.upload.sha256);
        record.bytes = bytes;
        record.upload.acceptedParts = [1];
      } else if (uploadPath[2] === '/complete') {
        expect(record.bytes?.length).toBe(record.upload.size);
        Object.assign(record.upload, {
          status: 'completed',
          completedAt: createdAt,
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          url: `${origin}/source/${record.upload.id}?signature=synthetic-input-link`,
        });
      }
      return respond(response, record.upload);
    }
    if (url.pathname === '/v1/open/avatars') {
      expect(body()).toEqual({
        name: 'Presenter',
        imageUrl: [...uploads.values()].find(
          ({ upload }) => upload.kind === 'avatar-image',
        )!.upload.url,
      });
      return respond(response, {
        jobId: avatarJobId,
        status: 'queued',
        createdAt,
      });
    }
    if (url.pathname === `/v1/open/avatar-jobs/${avatarJobId}`)
      return respond(response, {
        job: { id: avatarJobId, avatarId, status: 'succeeded', createdAt },
      });
    if (url.pathname === '/v1/open/videos') {
      expect(body()).toMatchObject({
        avatarId,
        audioUrl: [...uploads.values()].find(
          ({ upload }) => upload.kind === 'audio',
        )!.upload.url,
        video: { width: 1024, height: 1024, fit: 'crop' },
      });
      videoBodies.push(bytes.toString('utf8'));
      if (interruptAdmission) {
        const interrupt = interruptAdmission;
        interruptAdmission = undefined;
        // The service has admitted the request, but the process never receives
        // its job ID. A fresh process must replay exactly this request identity.
        interrupt();
        return;
      }
      expect(videoBodies.at(-1)).toBe(videoBodies[0]);
      return respond(response, {
        jobId: videoJobId,
        status: 'queued',
        createdAt,
      });
    }
    const jobId = url.pathname.startsWith('/v1/open/video-jobs/')
      ? url.pathname.split('/').at(-1)
      : undefined;
    if (jobId && [videoJobId, failedJobId, expiredJobId].includes(jobId)) {
      const status =
        jobId === failedJobId
          ? 'failed'
          : jobId === expiredJobId
            ? 'expired'
            : videoStatus;
      if (status === 'succeeded') downloadLinks++;
      return respond(response, {
        job: {
          id: jobId,
          avatarId,
          status,
          createdAt,
          expiresAt:
            status === 'expired'
              ? new Date(Date.now() - 1000).toISOString()
              : retainedUntil,
          ...(status === 'failed'
            ? {
                error: {
                  code: 'RENDER_FAILED',
                  message: 'Synthetic renderer failure.',
                  retryable: true,
                },
              }
            : {}),
        },
        ...(status === 'succeeded'
          ? {
              videoUrl: `${origin}/output.mp4?link=${downloadLinks}`,
              videoUrlExpiresAt: new Date(Date.now() + 900_000).toISOString(),
            }
          : {}),
      });
    }
    throw new Error(
      `Unexpected mock request: ${request.method} ${url.pathname}`,
    );
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      serverFailures.push(error);
      respond(response, { error: { code: 'MOCK_ROUTE_FAILED' } }, 400);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected loopback address.');
    origin = `http://127.0.0.1:${address.port}`;
    const originKey = hash(`${origin}\n${origin}`);
    const profileKey = hash(`${originKey}\n${userId}`);
    // Seed only a synthetic existing login, as in auth.test.ts. Every app,
    // upload, and render operation below goes through an independent CLI process.
    const storage = new AuthStorage(configDir);
    await storage.locked(async (state) => {
      state.active[originKey] = profileKey;
      state.profiles[profileKey] = {
        userId,
        studioOrigin: origin,
        consoleOrigin: origin,
        accessToken: secrets[0],
        refreshToken: secrets[1],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
      await storage.write(state);
    });
    const run = <T = Record<string, unknown>>(
      args: string[],
      interrupt = false,
    ): Promise<Result<T>> =>
      new Promise((resolve, reject) => {
        // Execute the source entrypoint so `pnpm test` also works before `build`.
        // This is the production Commander parser and JSON stdout/stderr envelope.
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', cli, ...args],
          {
            cwd: packageDirectory,
            env: {
              ...process.env,
              SPATIUS_NO_UPDATE_NOTIFIER: '1',
              SPATIUS_CONFIG_DIR: configDir,
              SPATIUS_STUDIO_URL: origin,
              SPATIUS_STUDIO_WEB_URL: origin,
              SPATIUS_CONSOLE_URL: origin,
              SPATIUS_MEDIA_URL: origin,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        if (interrupt)
          interruptAdmission = () => {
            child.kill('SIGINT');
          };
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(
            new Error(`CLI command timed out: ${args[0]} ${args[1] ?? ''}`),
          );
        }, 10_000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timeout);
          try {
            expect(serverFailures).toEqual([]);
            transcript.push(stdout, stderr);
            for (const secret of secrets)
              expect(stdout + stderr).not.toContain(secret);
            const lines = (text: string) =>
              text
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line));
            const results = lines(stdout);
            const events = lines(stderr);
            for (const event of [...results, ...events])
              expect(event.schemaVersion).toBe(1);
            expect(results).toHaveLength(code === 0 ? 1 : 0);
            if (code === 0) expect(results[0].ok).toBe(true);
            const failures = events.filter((event) => event.ok === false);
            expect(failures).toHaveLength(code === 0 ? 0 : 1);
            resolve({
              code,
              data: results[0]?.data as T | undefined,
              error: failures[0]?.error as Failure | undefined,
              events,
            });
          } catch (error) {
            reject(error);
          }
        });
      });
    const success = async <T = Record<string, unknown>>(args: string[]) => {
      const result = await run<T>(args);
      expect(result.code, JSON.stringify(result.error)).toBe(0);
      return result.data!;
    };

    // spatius-shared: discover the installed contract, check login, then setup.
    const schema = await success<{
      commands: Array<{ path: string }>;
      streams: Record<string, string>;
    }>(['schema']);
    expect(schema.streams).toEqual({
      result: 'stdout',
      error: 'stderr',
      progress: 'stderr',
    });
    expect(schema.commands.map((command) => command.path)).toEqual(
      expect.arrayContaining([
        'setup',
        'avatars create',
        'avatars jobs wait',
        'videos create',
        'videos wait',
        'videos download',
      ]),
    );
    expect(await success(['auth', 'status'])).toMatchObject({
      authenticated: true,
      userId,
    });
    expect(await success(['setup'])).toMatchObject({
      appId,
      userId,
      reused: false,
    });
    expect(await success(['setup'])).toMatchObject({ appId, reused: true });
    expect(mutations).toEqual([
      'POST /v1/apps',
      `POST /v1/apps/${appId}/api-keys`,
    ]);

    // spatius-avatar: validate before spending allowance, retain the accepted ID,
    // and use job.avatarId (not the creation job's ID) for the video request.
    await success(['schema', 'avatars', 'create']);
    expect(
      await success([
        'avatars',
        'create',
        '--image',
        imagePath,
        '--name',
        'Presenter',
        '--dry-run',
      ]),
    ).toMatchObject({
      dryRun: true,
      inputs: {
        imageUrl: { action: 'temporary_upload', contentType: 'image/png' },
      },
    });
    expect(uploads.size).toBe(0);
    const avatar = await success<{ operationId: string; jobId: string }>([
      'avatars',
      'create',
      '--image',
      imagePath,
      '--name',
      'Presenter',
    ]);
    expect(avatar.jobId).toBe(avatarJobId);
    const completedAvatar = await success<{ job: { avatarId: string } }>([
      'avatars',
      'jobs',
      'wait',
      avatar.jobId,
      '--timeout',
      '5',
    ]);
    expect(completedAvatar.job.avatarId).toBe(avatarId);

    // spatius-video: source uploads are immutable. Interrupted creation resumes
    // with the saved operation, without another upload or a new request UUID.
    await success(['schema', 'videos', 'create']);
    const videoArgs = [
      'videos',
      'create',
      '--avatar-id',
      completedAvatar.job.avatarId,
      '--audio',
      audioPath,
    ];
    expect(await success([...videoArgs, '--dry-run'])).toMatchObject({
      dryRun: true,
      inputs: {
        audioUrl: { action: 'temporary_upload', contentType: 'audio/wav' },
      },
    });
    expect(uploads.size).toBe(1);
    const interrupted = await run(videoArgs, true);
    expect(interrupted.code).toBe(130);
    expect(interrupted.error).toMatchObject({
      code: 'INTERRUPTED',
      retryable: false,
    });
    const operationId = interrupted.error!.details!.operationId!;
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(interrupted.error!.recovery).toContain(
      `videos create --resume ${operationId}`,
    );
    expect(videoBodies).toHaveLength(1);
    expect(JSON.parse(videoBodies[0]!).requestId).toBe(operationId);
    const accepted = await success<{ operationId: string; jobId: string }>([
      'videos',
      'create',
      '--resume',
      operationId,
    ]);
    expect(accepted).toMatchObject({ operationId, jobId: videoJobId });
    expect(videoBodies).toHaveLength(2);
    expect(videoBodies[0]).toBe(videoBodies[1]);
    expect(uploads.size).toBe(2);
    expect(
      await success(['videos', 'create', '--resume', operationId]),
    ).toEqual(accepted);
    expect(videoBodies).toHaveLength(2);

    // A wait deadline does not cancel or replace the remote job.
    const pending = await run([
      'videos',
      'wait',
      accepted.jobId,
      '--timeout',
      '0.1',
    ]);
    expect(pending.code).toBe(3);
    expect(pending.error).toMatchObject({
      code: 'WAIT_TIMEOUT',
      retryable: true,
      details: { jobId: videoJobId },
    });
    videoStatus = 'succeeded';
    expect(
      await success(['videos', 'wait', accepted.jobId, '--timeout', '5']),
    ).toMatchObject({
      job: { id: videoJobId, status: 'succeeded', expiresAt: retainedUntil },
    });

    // Signed links can expire before retained output does. Retry the download
    // read to get a fresh link; never create a replacement render for this.
    const unavailable = await run([
      'videos',
      'download',
      accepted.jobId,
      '--output',
      output,
    ]);
    expect(unavailable.error).toMatchObject({
      code: 'DOWNLOAD_UNAVAILABLE',
      retryable: true,
    });
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await readdir(directory)).some((path) => path.endsWith('.partial')),
    ).toBe(false);
    const beforeDownload = downloadLinks;
    expect(
      await success(['videos', 'download', accepted.jobId, '--output', output]),
    ).toEqual({ jobId: videoJobId, output, bytes: mp4Bytes.length });
    expect(downloadLinks).toBe(beforeDownload + 1);
    expect(await readFile(output)).toEqual(mp4Bytes);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(
      (await run(['videos', 'download', accepted.jobId, '--output', output]))
        .error?.code,
    ).toBe('OUTPUT_EXISTS');
    expect(await readFile(output)).toEqual(mp4Bytes);

    // Previously existing terminal jobs remain terminal even when the service
    // marks their error retryable. Expired output is not recovered by rerendering.
    const failed = await run(['videos', 'wait', failedJobId, '--timeout', '5']);
    expect(failed.error).toMatchObject({
      code: 'RENDER_FAILED',
      retryable: true,
    });
    expect(failed.error!.recovery).toContain('terminal');
    const expired = await run([
      'videos',
      'download',
      expiredJobId,
      '--output',
      join(directory, 'expired.mp4'),
    ]);
    expect(expired.error).toMatchObject({
      code: 'VIDEO_UNAVAILABLE',
      retryable: false,
    });
    expect(downloads).toBe(2);
    expect(videoBodies).toHaveLength(2);
    expect(
      mutations.filter((path) => path === 'POST /v1/open/avatars'),
    ).toHaveLength(1);
    expect(
      mutations.filter((path) => path === 'POST /v1/uploads'),
    ).toHaveLength(2);
    expect(
      (await readdir(directory)).some((path) => path.endsWith('.partial')),
    ).toBe(false);
    for (const secret of secrets)
      expect(transcript.join('')).not.toContain(secret);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
