import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, link, rename, unlink, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PART_SIZE,
  UUID_PATTERN,
  VIDEO_DEFAULTS,
  type MediaKind,
  type Upload,
  type VideoSettings,
  type CreatedJob,
  type JobDetail,
} from '@spatius/contracts';
import { CliError } from '../core/errors.js';
import { requestJson } from '../core/http.js';
import { MediaClient } from '../client/media.js';
import { StateStore, identifier } from './state.js';
import { inspectMedia, sourceUrl, type LocalMedia } from './media.js';

interface AuthAccess {
  accessToken(): Promise<string>;
  credentials(): Promise<{ appId: string; apiKey: string; userId?: string }>;
  identity(): Promise<{ userId: string; profileKey: string }>;
  stateDirectory(): string;
}
export interface WorkflowOptions {
  auth: AuthAccess;
  consoleOrigin: string;
  mediaOrigin: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (event: unknown) => void;
}
export interface ListOptions {
  pageSize?: number;
  pageToken?: string;
  statuses?: string[];
}
export interface WaitOptions {
  timeout?: number;
}
export interface CreateAvatarOptions extends WaitOptions {
  image?: string;
  name?: string;
  resume?: string;
  wait?: boolean;
  dryRun?: boolean;
}
export interface CreateVideoOptions extends WaitOptions {
  avatarId?: string;
  audio?: string;
  background?: string;
  name?: string;
  requestId?: string;
  video?: VideoSettings;
  resume?: string;
  wait?: boolean;
  dryRun?: boolean;
}
interface UploadJournal {
  version: 1;
  type: 'upload';
  id: string;
  userId: string;
  consoleOrigin: string;
  mediaOrigin: string;
  kind: MediaKind;
  file: LocalMedia;
  upload?: Upload;
}
interface Input {
  value: string;
  kind: MediaKind;
  file?: LocalMedia;
  uploadOperationId?: string;
  url?: string;
  expiresAt?: string;
}
interface CreateJournal {
  version: 1;
  type: 'avatar' | 'video';
  id: string;
  userId: string;
  appId: string;
  consoleOrigin: string;
  mediaOrigin: string;
  state: 'preparing' | 'ready' | 'submitting' | 'accepted';
  inputs: Record<string, Input>;
  body: Record<string, unknown>;
  job?: CreatedJob;
}
/** Milliseconds between job status polls in `waitJob`, per job kind. */
const JOB_POLL_INTERVALS: Record<'avatar' | 'video', number> = {
  avatar: 60_000,
  video: 10_000,
};

export class Workflows {
  readonly media: MediaClient;
  constructor(private readonly options: WorkflowOptions) {
    this.media = new MediaClient({
      origin: options.mediaOrigin.replace(/\/$/, ''),
      token: () => options.auth.accessToken(),
      fetch: options.fetch,
      signal: options.signal,
    });
  }
  private progress(event: unknown) {
    this.options.onProgress?.(event);
  }
  private async context() {
    const identity = await this.options.auth.identity();
    return {
      ...identity,
      store: new StateStore(
        this.options.auth.stateDirectory(),
        identity.profileKey,
      ),
    };
  }
  private checkScope(
    journal: { userId: string; consoleOrigin: string; mediaOrigin: string },
    userId: string,
  ) {
    if (
      journal.userId !== userId ||
      journal.consoleOrigin !== this.options.consoleOrigin ||
      journal.mediaOrigin !== this.options.mediaOrigin
    ) {
      throw new CliError(
        'OPERATION_SCOPE_MISMATCH',
        'The saved operation belongs to another account or service environment.',
      );
    }
  }
  async upload(
    file: string,
    options: { kind: MediaKind; resume?: string },
  ): Promise<Upload & { operationId: string }> {
    const local = await inspectMedia(file, options.kind, this.options.signal);
    const { store, userId } = await this.context();
    const id = options.resume
      ? identifier(options.resume, 'Upload operation ID')
      : randomUUID();
    return store.locked(id, async () => {
      let journal: UploadJournal;
      if (options.resume) {
        try {
          journal = await store.read<UploadJournal>(id);
        } catch (error) {
          if (
            !(error instanceof CliError) ||
            error.code !== 'OPERATION_NOT_FOUND'
          )
            throw error;
          const remote = await this.media.get(id);
          journal = {
            version: 1,
            type: 'upload',
            id,
            userId,
            consoleOrigin: this.options.consoleOrigin,
            mediaOrigin: this.options.mediaOrigin,
            kind: options.kind,
            file: local,
            upload: remote,
          };
        }
        this.checkScope(journal, userId);
        if (
          journal.type !== 'upload' ||
          journal.kind !== options.kind ||
          journal.file.sha256 !== local.sha256 ||
          journal.file.size !== local.size ||
          journal.file.contentType !== local.contentType
        ) {
          throw new CliError(
            'INPUT_CHANGED',
            'Upload resume requires the original file bytes and media kind.',
          );
        }
      } else {
        journal = {
          version: 1,
          type: 'upload',
          id,
          userId,
          consoleOrigin: this.options.consoleOrigin,
          mediaOrigin: this.options.mediaOrigin,
          kind: options.kind,
          file: local,
        };
        await store.write(id, journal);
      }
      this.progress({ stage: 'uploading', operationId: id });
      try {
        let remote = journal.upload
          ? await this.media.get(journal.upload.id)
          : await this.media.create({
              requestId: id,
              kind: options.kind,
              size: local.size,
              contentType: local.contentType,
              sha256: local.sha256,
            });
        journal.upload = remote;
        await store.write(id, journal);
        const validate = () => {
          if (
            remote.sha256 !== local.sha256 ||
            remote.size !== local.size ||
            remote.kind !== options.kind ||
            remote.partSize !== PART_SIZE
          )
            throw new CliError(
              'INVALID_RESPONSE',
              'The upload service returned incompatible file metadata.',
            );
          if (['expired', 'aborted', 'aborting'].includes(remote.status))
            throw new CliError(
              'UPLOAD_EXPIRED',
              'This upload is no longer resumable.',
              {
                recovery:
                  'Start a new upload. Do not replace input URLs in an uncertain video submission.',
              },
            );
        };
        validate();
        remote = await this.settleUpload(remote, id);
        validate();
        journal.upload = remote;
        await store.write(id, journal);
        if (remote.status === 'completed')
          return this.completedUpload(remote, id);
        const handle = await open(local.path, 'r');
        try {
          for (
            let number = 1;
            number <= Math.ceil(local.size / PART_SIZE);
            number++
          ) {
            if (remote.status === 'completed') break;
            if (remote.acceptedParts.includes(number)) continue;
            const length = Math.min(
              PART_SIZE,
              local.size - (number - 1) * PART_SIZE,
            );
            const bytes = Buffer.alloc(length);
            let read = 0;
            while (read < length) {
              const result = await handle.read(
                bytes,
                read,
                length - read,
                (number - 1) * PART_SIZE + read,
              );
              if (!result.bytesRead)
                throw new CliError(
                  'INPUT_CHANGED',
                  'The file changed during upload.',
                );
              read += result.bytesRead;
            }
            const hash = createHash('sha256').update(bytes).digest('hex');
            for (let attempt = 0; ; attempt++) {
              try {
                remote = await this.media.part(remote.id, number, bytes, hash);
                break;
              } catch (error) {
                if (
                  !(error instanceof CliError) ||
                  !error.options.retryable ||
                  (error.options.retryAfter ?? 0) > 30 ||
                  attempt >= 4
                )
                  throw error;
                await this.pause(
                  Math.max(
                    error.options.retryAfter ?? 0,
                    Math.min(2 ** attempt, 15),
                  ) * 1000,
                );
                remote = await this.settleUpload(
                  await this.media.get(remote.id),
                  id,
                );
                validate();
                if (
                  remote.acceptedParts.includes(number) ||
                  remote.status === 'completed'
                )
                  break;
              }
            }
            journal.upload = remote;
            await store.write(id, journal);
            this.progress({
              stage: 'uploading',
              operationId: id,
              acceptedParts: remote.acceptedParts.length,
              partCount: remote.partCount,
            });
          }
        } finally {
          await handle.close();
        }
        // Completion checks the whole-file digest in the Worker before issuing a URL.
        for (let attempt = 0; ; attempt++) {
          try {
            remote =
              remote.status === 'completed'
                ? remote
                : await this.media.complete(remote.id);
            remote = await this.settleUpload(remote, id);
            break;
          } catch (error) {
            if (
              !(error instanceof CliError) ||
              !error.options.retryable ||
              (error.options.retryAfter ?? 0) > 30 ||
              attempt >= 4
            )
              throw error;
            await this.pause(
              Math.max(
                error.options.retryAfter ?? 0,
                Math.min(2 ** attempt, 15),
              ) * 1000,
            );
            remote = await this.settleUpload(
              await this.media.get(remote.id),
              id,
            );
            validate();
          }
        }
        journal.upload = remote;
        await store.write(id, journal);
        return this.completedUpload(remote, id);
      } catch (error) {
        throw this.withOperation(error, id, 'assets upload');
      }
    });
  }
  private async settleUpload(
    initial: Upload,
    operationId: string,
  ): Promise<Upload> {
    let upload = initial;
    const expiry = Date.parse(initial.uploadExpiresAt);
    if (!Number.isFinite(expiry))
      throw new CliError(
        'INVALID_RESPONSE',
        'The upload service returned an invalid transfer deadline.',
      );
    const serverDeadline =
      expiry + (initial.status === 'finalizing' ? 300_000 : 0);
    const deadline = Math.min(Date.now() + 300_000, serverDeadline);
    const waiting = () =>
      ['initializing', 'finalizing'].includes(upload.status);
    if (waiting() && deadline <= Date.now())
      throw new CliError(
        'UPLOAD_EXPIRED',
        'The upload preparation deadline has expired.',
      );
    const deadlineSignal = AbortSignal.timeout(
      Math.max(1, Math.ceil(deadline - Date.now())),
    );
    const signal = AbortSignal.any([
      deadlineSignal,
      ...(this.options.signal ? [this.options.signal] : []),
    ]);
    for (let attempt = 0; waiting(); attempt++) {
      this.progress({ stage: upload.status, operationId, uploadId: upload.id });
      try {
        const interval = Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4));
        const remaining = deadline - Date.now();
        await delay(Math.min(interval, Math.max(1, remaining)), undefined, {
          signal,
        });
        // A shortened final sleep cannot trigger an extra poll before the normal interval.
        if (remaining <= interval) {
          if (deadline === serverDeadline)
            throw new CliError(
              'UPLOAD_EXPIRED',
              'The upload preparation deadline has expired.',
            );
          throw new CliError(
            'UPLOAD_WAIT_TIMEOUT',
            'The upload is still initializing or verifying. Its saved state can be resumed.',
            { retryable: true },
          );
        }
        upload = await this.media.get(initial.id, signal);
      } catch (error) {
        this.options.signal?.throwIfAborted();
        if (deadlineSignal.aborted && Date.now() >= serverDeadline)
          throw new CliError(
            'UPLOAD_EXPIRED',
            'The upload preparation deadline has expired.',
          );
        if (deadlineSignal.aborted)
          throw new CliError(
            'UPLOAD_WAIT_TIMEOUT',
            'The upload is still initializing or verifying. Its saved state can be resumed.',
            { retryable: true },
          );
        throw error;
      }
      if (
        upload.id !== initial.id ||
        upload.sha256 !== initial.sha256 ||
        upload.size !== initial.size ||
        upload.kind !== initial.kind ||
        upload.contentType !== initial.contentType ||
        upload.partSize !== PART_SIZE
      ) {
        throw new CliError(
          'INVALID_RESPONSE',
          'The upload identity changed while waiting.',
        );
      }
    }
    if (
      ['expired', 'aborted', 'aborting'].includes(upload.status) ||
      (upload.status === 'uploading' &&
        Date.parse(upload.uploadExpiresAt) <= Date.now())
    ) {
      throw new CliError(
        'UPLOAD_EXPIRED',
        'This upload is no longer resumable.',
        {
          recovery:
            'Start a new upload. Do not replace input URLs in an uncertain video submission.',
        },
      );
    }
    if (!['uploading', 'completed'].includes(upload.status))
      throw new CliError(
        'INVALID_RESPONSE',
        'The upload service returned an invalid status.',
      );
    return upload;
  }
  private completedUpload(upload: Upload, operationId: string) {
    if (
      upload.status !== 'completed' ||
      !upload.url ||
      !upload.expiresAt ||
      !Number.isFinite(Date.parse(upload.expiresAt)) ||
      Date.parse(upload.expiresAt) <= Date.now()
    )
      throw new CliError(
        'UPLOAD_NOT_READY',
        'The upload is not ready for use.',
        { retryable: true },
      );
    const source = sourceUrl(upload.url);
    if (!source)
      throw new CliError(
        'INVALID_RESPONSE',
        'The upload service returned an invalid file URL.',
      );
    const parsed = new URL(source);
    const localHTTP =
      parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (
      parsed.origin !== new URL(this.options.mediaOrigin).origin ||
      (parsed.protocol !== 'https:' && !localHTTP)
    ) {
      throw new CliError(
        'INVALID_RESPONSE',
        'The upload file URL must use the configured media service over HTTPS (or loopback HTTP for local development).',
      );
    }
    return { ...upload, operationId };
  }
  getUpload(id: string) {
    return this.media.get(identifier(id, 'Upload ID'));
  }
  abortUpload(id: string) {
    return this.media.abort(identifier(id, 'Upload ID'));
  }
  private withOperation(
    error: unknown,
    operationId: string,
    command: string,
  ): CliError {
    const original =
      error instanceof CliError
        ? error
        : new CliError(
            'OPERATION_FAILED',
            'The operation stopped before completion.',
          );
    const inherited = original.options.details;
    const plainDetails =
      inherited !== null &&
      typeof inherited === 'object' &&
      (Object.getPrototypeOf(inherited) === Object.prototype ||
        Object.getPrototypeOf(inherited) === null)
        ? (inherited as Record<string, unknown>)
        : {};
    const details = { ...plainDetails, operationId };
    const recovery =
      command === 'assets upload'
        ? `Run spatius assets upload with the original file and --kind, adding --resume ${operationId}.`
        : `Resume with spatius ${command} --resume ${operationId}.`;
    if (this.options.signal?.aborted)
      return new CliError(
        'INTERRUPTED',
        'Operation interrupted; its progress has been saved.',
        {
          exitCode: 130,
          details,
          recovery,
        },
      );
    return new CliError(original.code, original.message, {
      ...original.options,
      details,
      recovery: original.options.recovery ?? recovery,
    });
  }
  private async input(
    value: string | undefined,
    kind: MediaKind,
  ): Promise<Input> {
    if (!value)
      throw new CliError('INVALID_ARGUMENT', `A ${kind} input is required.`, {
        exitCode: 2,
      });
    const url = sourceUrl(value);
    return url
      ? { value, kind, url }
      : {
          value,
          kind,
          file: await inspectMedia(value, kind, this.options.signal),
          uploadOperationId: randomUUID(),
        };
  }
  private videoSettings(
    video: VideoSettings = {},
    hasBackground = false,
  ): VideoSettings {
    const settings = { ...VIDEO_DEFAULTS, ...video };
    for (const dimension of [settings.width, settings.height])
      if (
        !Number.isInteger(dimension) ||
        dimension < 64 ||
        dimension > 1920 ||
        dimension % 2
      )
        throw new CliError(
          'INVALID_ARGUMENT',
          'Video dimensions must be even integers from 64 to 1920.',
          { exitCode: 2 },
        );
    if (
      settings.width * settings.height > 2_073_600 ||
      !['crop', 'contain'].includes(settings.fit) ||
      !['cover', 'contain', 'stretch'].includes(settings.backgroundFit) ||
      !/^#[0-9a-f]{6}$/i.test(settings.backgroundColor)
    )
      throw new CliError(
        'INVALID_ARGUMENT',
        'Invalid video presentation settings.',
        { exitCode: 2 },
      );
    for (const duration of [settings.leadInSeconds, settings.leadOutSeconds])
      if (!Number.isFinite(duration) || duration < 0 || duration > 60)
        throw new CliError(
          'INVALID_ARGUMENT',
          'Lead-in and lead-out must be finite seconds from 0 to 60.',
          { exitCode: 2 },
        );
    settings.backgroundColor = settings.backgroundColor.toLowerCase();
    if (!hasBackground) return settings;
    // With a background, the service derives the frame from the image unless
    // the caller sets a size or fit explicitly. Do not send CLI defaults.
    const explicit: VideoSettings = { ...settings };
    for (const key of ['width', 'height', 'fit'] as const)
      if (video[key] === undefined) delete explicit[key];
    return explicit;
  }
  private name(name: string | undefined) {
    if (name !== undefined && (!name.trim() || name.length > 128))
      throw new CliError(
        'INVALID_ARGUMENT',
        'Name must contain 1 to 128 characters.',
        { exitCode: 2 },
      );
    return name;
  }
  async createAvatar(options: CreateAvatarOptions) {
    if (options.resume) {
      if (
        options.image !== undefined ||
        options.name !== undefined ||
        options.dryRun
      )
        throw new CliError(
          'INVALID_ARGUMENT',
          'Resume cannot be combined with new inputs or dry-run.',
          { exitCode: 2 },
        );
      return this.create('avatar', options);
    }
    const inputs = {
      imageUrl: await this.input(options.image, 'avatar-image'),
    };
    return this.create('avatar', options, inputs, {
      ...(this.name(options.name) !== undefined ? { name: options.name } : {}),
    });
  }
  async createVideo(options: CreateVideoOptions) {
    if (options.resume) {
      if (
        [
          options.avatarId,
          options.audio,
          options.background,
          options.name,
          options.requestId,
        ].some((value) => value !== undefined) ||
        (options.video && Object.keys(options.video).length > 0) ||
        options.dryRun
      )
        throw new CliError(
          'INVALID_ARGUMENT',
          'Resume cannot be combined with new inputs or dry-run.',
          { exitCode: 2 },
        );
      return this.create('video', options);
    }
    if (!options.avatarId)
      throw new CliError('INVALID_ARGUMENT', 'An Avatar ID is required.', {
        exitCode: 2,
      });
    const avatarId = identifier(options.avatarId, 'Avatar ID');
    const inputs: Record<string, Input> = {
      audioUrl: await this.input(options.audio, 'audio'),
    };
    if (options.background)
      inputs.backgroundUrl = await this.input(options.background, 'background');
    return this.create('video', options, inputs, {
      avatarId,
      requestId: options.requestId
        ? identifier(options.requestId, 'Request ID')
        : randomUUID(),
      video: this.videoSettings(
        options.video,
        options.background !== undefined,
      ),
      ...(this.name(options.name) !== undefined ? { name: options.name } : {}),
    });
  }
  private async create(
    kind: 'avatar' | 'video',
    options: {
      resume?: string;
      dryRun?: boolean;
      wait?: boolean;
      timeout?: number;
    },
    inputs?: Record<string, Input>,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    if (options.dryRun)
      return {
        dryRun: true,
        method: 'POST',
        path: `/v1/open/${kind === 'avatar' ? 'avatars' : 'videos'}`,
        body,
        inputs: Object.fromEntries(
          Object.entries(inputs ?? {}).map(([key, input]) => [
            key,
            input.file
              ? {
                  kind: input.kind,
                  path: input.file.path,
                  size: input.file.size,
                  contentType: input.file.contentType,
                  sha256: input.file.sha256,
                  action: 'temporary_upload',
                }
              : { kind: input.kind, action: 'use_supplied_url' },
          ]),
        ),
      };
    const { store, userId } = await this.context();
    const credentials = await this.options.auth.credentials();
    const id = options.resume
      ? identifier(options.resume, 'Operation ID')
      : kind === 'video'
        ? identifier(String(body!.requestId), 'Request ID')
        : randomUUID();
    return store.locked(id, async () => {
      let journal: CreateJournal;
      let existing: CreateJournal | undefined;
      try {
        existing = await store.read<CreateJournal>(id);
      } catch (error) {
        if (
          !(error instanceof CliError) ||
          error.code !== 'OPERATION_NOT_FOUND' ||
          options.resume
        )
          throw error;
      }
      if (existing) {
        journal = existing;
        this.checkScope(journal, userId);
        if (journal.type !== kind || journal.appId !== credentials.appId)
          throw new CliError(
            'OPERATION_SCOPE_MISMATCH',
            'Resume requires the original command and App ID.',
          );
        if (
          !options.resume &&
          inputFingerprint(journal.body, journal.inputs) !==
            inputFingerprint(body!, inputs!)
        ) {
          throw new CliError(
            'REQUEST_ID_CONFLICT',
            'This request ID is already associated with different inputs.',
            {
              status: 409,
              recovery:
                'Reuse the original inputs, or choose a new request ID for a separate render.',
            },
          );
        }
      } else {
        journal = {
          version: 1,
          type: kind,
          id,
          userId,
          appId: credentials.appId,
          consoleOrigin: this.options.consoleOrigin,
          mediaOrigin: this.options.mediaOrigin,
          state: 'preparing',
          inputs: inputs!,
          body: body!,
        };
        await store.write(id, journal);
      }
      this.progress({ stage: journal.state, operationId: id });
      try {
        if (journal.state === 'accepted' && journal.job)
          return options.wait
            ? {
                operationId: id,
                ...(await this.waitJob(kind, journal.job.jobId, options)),
              }
            : { operationId: id, ...journal.job };
        if (journal.state === 'submitting' && kind === 'avatar')
          throw new CliError(
            'SUBMISSION_UNCERTAIN',
            'Avatar creation may already have been accepted. It cannot safely be submitted again automatically.',
            {
              recovery:
                'Inspect spatius avatars jobs list and match the previous creation before starting another avatar.',
            },
          );
        for (const [field, input] of Object.entries(journal.inputs)) {
          if (!input.url) {
            if (!input.file || !input.uploadOperationId)
              throw new CliError(
                'INVALID_OPERATION',
                'The saved input is incomplete.',
              );
            const current = await inspectMedia(
              input.file.path,
              input.kind,
              this.options.signal,
            );
            if (
              current.sha256 !== input.file.sha256 ||
              current.size !== input.file.size
            )
              throw new CliError(
                'INPUT_CHANGED',
                'The local input changed since this operation started.',
              );
            // The upload operation is initialized before sending anything. The exact ID is durable in the parent journal.
            let exists = true;
            try {
              await store.read(input.uploadOperationId);
            } catch (error) {
              if (
                error instanceof CliError &&
                error.code === 'OPERATION_NOT_FOUND'
              )
                exists = false;
              else throw error;
            }
            if (!exists)
              await store.write(input.uploadOperationId, {
                version: 1,
                type: 'upload',
                id: input.uploadOperationId,
                userId,
                consoleOrigin: this.options.consoleOrigin,
                mediaOrigin: this.options.mediaOrigin,
                kind: input.kind,
                file: input.file,
              } satisfies UploadJournal);
            const uploaded = await this.upload(input.file.path, {
              kind: input.kind,
              resume: input.uploadOperationId,
            });
            input.url = uploaded.url;
            input.expiresAt = uploaded.expiresAt;
            journal.body[field] = input.url;
            await store.write(id, journal);
          } else journal.body[field] = input.url;
          if (
            input.expiresAt &&
            Date.parse(input.expiresAt) <= Date.now() + 30 * 60_000
          )
            throw new CliError(
              'SOURCE_EXPIRED',
              'A saved input URL no longer covers the preparation window.',
              {
                recovery:
                  journal.state === 'submitting'
                    ? 'Inspect existing video jobs. Do not substitute another URL under this request ID.'
                    : 'Start a new operation to upload fresh inputs.',
              },
            );
        }
        journal.state = 'ready';
        await store.write(id, journal);
        journal.state = 'submitting';
        await store.write(id, journal);
        const attempts = kind === 'video' ? 3 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            const result = await this.consoleRequest<CreatedJob>(
              kind === 'video' ? '/videos' : '/avatars',
              'POST',
              journal.body,
              false,
              this.options.signal,
              { appId: journal.appId, userId: journal.userId },
            );
            if (!result.jobId || !UUID_PATTERN.test(result.jobId))
              throw new CliError(
                'INVALID_RESPONSE',
                'Creation response did not include a valid job ID.',
                { retryable: kind === 'video' },
              );
            journal.job = result;
            journal.state = 'accepted';
            await store.write(id, journal);
            break;
          } catch (error) {
            const rejected =
              error instanceof CliError &&
              error.options.status !== undefined &&
              error.options.status >= 400 &&
              error.options.status < 500;
            if (
              rejected ||
              (error instanceof CliError &&
                error.code === 'OPERATION_SCOPE_MISMATCH')
            ) {
              journal.state = 'ready';
              await store.write(id, journal);
            } else if (kind === 'avatar') {
              throw new CliError(
                'SUBMISSION_UNCERTAIN',
                'Avatar creation may already have been accepted. Do not submit it again automatically.',
                {
                  recovery:
                    'Inspect spatius avatars jobs list and match the previous creation before starting another avatar.',
                },
              );
            }
            if (
              !(error instanceof CliError) ||
              !error.options.retryable ||
              (error.options.retryAfter ?? 0) > 30 ||
              attempt + 1 >= attempts
            )
              throw error;
            journal.state = 'submitting';
            await store.write(id, journal);
            await this.pause(
              Math.max(error.options.retryAfter ?? 0, 2 ** attempt) * 1000,
            );
          }
        }
        return options.wait
          ? {
              operationId: id,
              ...(await this.waitJob(kind, journal.job!.jobId, options)),
            }
          : { operationId: id, ...journal.job! };
      } catch (error) {
        throw this.withOperation(
          error,
          id,
          `${kind === 'avatar' ? 'avatars' : 'videos'} create`,
        );
      }
    });
  }
  private async consoleRequest<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    retry = true,
    signal = this.options.signal,
    owner?: { appId: string; userId: string },
  ): Promise<T> {
    const credentials = await this.options.auth.credentials();
    if (owner) {
      const identity = await this.options.auth.identity();
      if (
        credentials.appId !== owner.appId ||
        identity.userId !== owner.userId ||
        (credentials.userId !== undefined &&
          credentials.userId !== owner.userId)
      )
        throw new CliError(
          'OPERATION_SCOPE_MISMATCH',
          'The active account or App changed while preparing this operation. Resume under the original identity.',
        );
    }
    return requestJson<T>(
      `${this.options.consoleOrigin.replace(/\/$/, '')}/v1/open${path}`,
      {
        method,
        body,
        headers: {
          'x-app-id': credentials.appId,
          'x-api-key': credentials.apiKey,
        },
        signal,
        fetch: this.options.fetch,
        retry: method === 'GET' && retry,
      },
    );
  }
  getAvatar(id: string) {
    return this.consoleRequest<unknown>(
      `/avatars/${identifier(id, 'Avatar ID')}`,
    );
  }
  listAvatars(options: ListOptions = {}) {
    return this.consoleRequest<unknown>(`/avatars${this.query(options)}`);
  }
  getJob(kind: 'avatar' | 'video', id: string) {
    return this.consoleRequest<JobDetail>(
      `/${kind}-jobs/${identifier(id, 'Job ID')}`,
    );
  }
  listJobs(kind: 'avatar' | 'video', options: ListOptions = {}) {
    return this.consoleRequest<unknown>(`/${kind}-jobs${this.query(options)}`);
  }
  private query(options: ListOptions) {
    const query = new URLSearchParams();
    if (options.pageSize !== undefined) {
      if (
        !Number.isInteger(options.pageSize) ||
        options.pageSize < 1 ||
        options.pageSize > 100
      )
        throw new CliError(
          'INVALID_ARGUMENT',
          'Page size must be an integer from 1 to 100.',
          { exitCode: 2 },
        );
      query.set('pagination.pageSize', String(options.pageSize));
    }
    if (options.pageToken) query.set('pagination.pageToken', options.pageToken);
    for (const status of options.statuses ?? []) {
      if (
        !['queued', 'processing', 'succeeded', 'failed', 'expired'].includes(
          status,
        )
      )
        throw new CliError('INVALID_ARGUMENT', 'Invalid job status.', {
          exitCode: 2,
        });
      query.append('statuses', status);
    }
    return query.size ? `?${query}` : '';
  }
  async waitJob(
    kind: 'avatar' | 'video',
    id: string,
    options: WaitOptions = {},
  ): Promise<JobDetail> {
    identifier(id, 'Job ID');
    const pollInterval = JOB_POLL_INTERVALS[kind];
    const timeout = options.timeout ?? 600;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86_400)
      throw new CliError(
        'INVALID_ARGUMENT',
        'Timeout must be seconds greater than zero and at most 86400.',
        { exitCode: 2 },
      );
    const deadline = Date.now() + timeout * 1000;
    const deadlineSignal = AbortSignal.timeout(Math.ceil(timeout * 1000));
    const signal = AbortSignal.any([
      deadlineSignal,
      ...(this.options.signal ? [this.options.signal] : []),
    ]);
    for (;;) {
      let detail: JobDetail;
      try {
        detail = await this.consoleRequest<JobDetail>(
          `/${kind}-jobs/${id}`,
          'GET',
          undefined,
          true,
          signal,
        );
      } catch (error) {
        if (deadlineSignal.aborted && !this.options.signal?.aborted)
          throw this.waitTimeout(kind, id);
        throw error;
      }
      const job = detail.job;
      if (
        !job ||
        !['queued', 'processing', 'succeeded', 'failed', 'expired'].includes(
          job.status,
        )
      )
        throw new CliError(
          'INVALID_RESPONSE',
          'The job service returned an invalid status.',
        );
      this.progress({
        stage: job.progress?.stage ?? job.status,
        jobId: id,
        status: job.status,
      });
      if (job.status === 'succeeded') return detail;
      if (job.status === 'failed' || job.status === 'expired')
        throw new CliError(
          job.error?.code ??
            (job.status === 'expired' ? 'JOB_EXPIRED' : 'JOB_FAILED'),
          job.error?.message ?? 'The job did not succeed.',
          {
            retryable: job.error?.retryable ?? false,
            details: { jobId: id, status: job.status },
            recovery:
              'This job is terminal. Inspect its error before deliberately creating another job.',
          },
        );
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw this.waitTimeout(kind, id);
      try {
        await delay(Math.min(pollInterval, remaining), undefined, { signal });
        // A shortened final sleep reaches the wait boundary, not another poll.
        if (remaining <= pollInterval) throw this.waitTimeout(kind, id);
      } catch {
        if (this.options.signal?.aborted) this.options.signal.throwIfAborted();
        throw this.waitTimeout(kind, id);
      }
    }
  }
  private waitTimeout(kind: string, id: string) {
    return new CliError(
      'WAIT_TIMEOUT',
      'The job is still running when the wait deadline ended.',
      {
        retryable: true,
        exitCode: 3,
        details: { jobId: id },
        recovery: `Continue with spatius ${kind === 'avatar' ? 'avatars jobs' : 'videos'} wait ${id}. The remote job was not cancelled.`,
      },
    );
  }
  private async pause(milliseconds: number) {
    await delay(milliseconds, undefined, { signal: this.options.signal });
  }
  async download(jobId: string, options: { output: string; force?: boolean }) {
    const output = resolve(options.output);
    const directory = dirname(output);
    if (
      !options.force &&
      (await stat(output).then(
        () => true,
        () => false,
      ))
    )
      throw new CliError(
        'OUTPUT_EXISTS',
        'The output file already exists. Use --force to replace it.',
        { exitCode: 2 },
      );
    const detail = await this.getJob('video', jobId);
    if (
      detail.job.status !== 'succeeded' ||
      !detail.videoUrl ||
      (detail.job.expiresAt && Date.parse(detail.job.expiresAt) <= Date.now())
    )
      throw new CliError(
        'VIDEO_UNAVAILABLE',
        'The video is not ready or its output has expired.',
        { retryable: ['queued', 'processing'].includes(detail.job.status) },
      );
    if (!sourceUrl(detail.videoUrl))
      throw new CliError(
        'INVALID_RESPONSE',
        'The video service returned an invalid download URL.',
      );
    const downloadURL = new URL(detail.videoUrl);
    const consoleURL = new URL(this.options.consoleOrigin);
    const isLoopback = (hostname: string) =>
      ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    if (
      downloadURL.protocol !== 'https:' &&
      !(
        downloadURL.protocol === 'http:' &&
        isLoopback(downloadURL.hostname) &&
        consoleURL.protocol === 'http:' &&
        isLoopback(consoleURL.hostname)
      )
    ) {
      throw new CliError(
        'DOWNLOAD_UNAVAILABLE',
        'The video service returned an insecure output URL.',
        {
          retryable: true,
          recovery:
            'Request a fresh download link. Only HTTPS output links are supported outside explicitly configured loopback development.',
        },
      );
    }
    await mkdir(directory, { recursive: true });
    const temporary = `${output}.${randomUUID()}.partial`;
    const handle = await open(temporary, 'wx', 0o600);
    let bytes = 0;
    try {
      const signal = AbortSignal.any([
        AbortSignal.timeout(600_000),
        ...(this.options.signal ? [this.options.signal] : []),
      ]);
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(detail.videoUrl, {
          signal,
          redirect: 'error',
        });
      } catch {
        this.options.signal?.throwIfAborted();
        throw new CliError(
          'DOWNLOAD_UNAVAILABLE',
          'The direct signed video download could not be reached.',
          {
            retryable: true,
            recovery:
              'Run the download command again to obtain a fresh signed URL. Output redirects are not followed.',
          },
        );
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new CliError(
          'DOWNLOAD_UNAVAILABLE',
          'The signed video download is unavailable.',
          {
            retryable: true,
            recovery:
              'Run the download command again to obtain a fresh signed URL.',
          },
        );
      }
      const reader = response.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          let offset = 0;
          while (offset < next.value.byteLength) {
            const result = await handle.write(next.value, offset);
            offset += result.bytesWritten;
          }
          bytes += next.value.byteLength;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!bytes)
        throw new CliError('DOWNLOAD_EMPTY', 'The video download was empty.', {
          retryable: true,
        });
      await handle.sync();
      await handle.close();
      if (options.force) await rename(temporary, output);
      else {
        await link(temporary, output);
        await unlink(temporary);
      }
      return { jobId, output, bytes };
    } catch (error) {
      if (error instanceof CliError) throw error;
      this.options.signal?.throwIfAborted();
      throw new CliError(
        'DOWNLOAD_FAILED',
        'The video download did not complete.',
        {
          retryable: true,
          recovery:
            'Run the download command again; no partial result replaced the destination.',
        },
      );
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
}

// Stable original input identity excludes generated upload URLs and file locations.
// Repeating a request ID can therefore reuse the same uploaded bytes from another path.
function inputFingerprint(
  body: Record<string, unknown>,
  inputs: Record<string, Input>,
): string {
  const request = Object.fromEntries(
    Object.entries(body).filter(([key]) => !Object.hasOwn(inputs, key)),
  );
  const sources = Object.fromEntries(
    Object.entries(inputs).map(([key, input]) => [
      key,
      input.file
        ? {
            kind: input.kind,
            sha256: input.file.sha256,
            size: input.file.size,
            contentType: input.file.contentType,
          }
        : { kind: input.kind, url: input.value },
    ]),
  );
  const canonical = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical({ request, sources })))
    .digest('hex');
}
