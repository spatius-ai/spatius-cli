import { createHash } from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';
import {
  INPUT_TTL_MS,
  PART_SIZE,
  UPLOAD_TTL_MS,
  UUID_PATTERN,
  isMediaKind,
  validMedia,
  type CreateUpload,
  type Upload,
  type UploadStatus,
} from '@spatius/contracts';
import { attempt, HttpError, object, type Outcome } from './errors.js';
import { fileURL } from './signing.js';
import { uploadLimits } from './limits.js';

const DAY = 86400000;
export const PART_TIMEOUT_MS = 120000;
interface Part {
  number: number;
  etag: string;
  digest: string;
  size: number;
}
interface Pending {
  operationId: string;
  number: number;
  digest: string;
  deadline: number;
}
interface RecordData {
  input: CreateUpload;
  id: string;
  status: UploadStatus;
  createdAt: number;
  uploadExpiresAt: number;
  deadline: number;
  reserved: boolean;
  multipartId?: string;
  parts: Part[];
  pending?: Pending;
  completedAt?: number;
  expiresAt?: number;
  url?: string;
}
export interface PartPermit {
  upload: Upload;
  operationId?: string;
  multipartId?: string;
  key?: string;
  size?: number;
  contentType?: string;
}
function validateInput(value: unknown): CreateUpload {
  const body = object(value);
  if (
    typeof body.requestId !== 'string' ||
    !UUID_PATTERN.test(body.requestId) ||
    typeof body.kind !== 'string' ||
    !isMediaKind(body.kind) ||
    typeof body.contentType !== 'string' ||
    typeof body.size !== 'number' ||
    !validMedia(body.kind, body.contentType, body.size) ||
    typeof body.sha256 !== 'string' ||
    !/^[a-f\d]{64}$/i.test(body.sha256)
  )
    throw new HttpError(
      400,
      'invalid_request',
      'Supply a request UUID, supported media kind/type, allowed nonzero byte size, and SHA-256 digest.',
    );
  return {
    requestId: body.requestId.toLowerCase(),
    kind: body.kind,
    contentType: body.contentType,
    size: body.size,
    sha256: body.sha256.toLowerCase(),
  };
}
function key(record: RecordData): string {
  return `media/${record.id}`;
}
function view(record: RecordData): Upload {
  const status =
    record.status === 'completed' &&
    (record.expiresAt ?? Infinity) <= Date.now()
      ? 'expired'
      : record.status;
  return {
    id: record.id,
    ...record.input,
    status,
    partSize: PART_SIZE,
    partCount: Math.ceil(record.input.size / PART_SIZE),
    acceptedParts: record.parts.map((part) => part.number),
    createdAt: new Date(record.createdAt).toISOString(),
    uploadExpiresAt: new Date(record.uploadExpiresAt).toISOString(),
    ...(record.completedAt === undefined
      ? {}
      : { completedAt: new Date(record.completedAt).toISOString() }),
    ...(record.expiresAt === undefined
      ? {}
      : { expiresAt: new Date(record.expiresAt).toISOString() }),
    ...(status === 'completed' && record.url ? { url: record.url } : {}),
  };
}
export class UploadCoordinator extends DurableObject<Env> {
  private readonly verifications = new Map<string, Promise<RecordData>>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, reserved INTEGER NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL, deadline INTEGER NOT NULL, data TEXT NOT NULL)`,
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS uploads_created ON uploads(created_at)',
    );
    this.ctx.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS uploads_due ON uploads(reserved, deadline)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS rate_bucket (id INTEGER PRIMARY KEY, tokens REAL NOT NULL, updated REAL NOT NULL)',
    );
  }
  private read(id: string): RecordData {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>('SELECT data FROM uploads WHERE id = ?', id)
      .toArray()[0];
    if (!row) throw new HttpError(404, 'upload_not_found', 'Upload not found.');
    return JSON.parse(row.data) as RecordData;
  }
  private save(record: RecordData): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO uploads (id,request_id,created_at,reserved,size,status,deadline,data) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET reserved=excluded.reserved,status=excluded.status,deadline=excluded.deadline,data=excluded.data`,
      record.id,
      record.input.requestId,
      record.createdAt,
      record.reserved ? 1 : 0,
      record.input.size,
      record.status,
      record.deadline,
      JSON.stringify(record),
    );
  }
  private async schedule(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ due: number | null }>(
        'SELECT MIN(deadline) AS due FROM uploads WHERE reserved = 1',
      )
      .one();
    if (row.due !== null)
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, row.due));
    else await this.ctx.storage.deleteAlarm();
  }
  async rateLimit(): Promise<Outcome<null>> {
    return attempt(() => {
      const limits = uploadLimits(this.env);
      const now = Date.now();
      const old = this.ctx.storage.sql
        .exec<{ tokens: number; updated: number }>(
          'SELECT tokens,updated FROM rate_bucket WHERE id=1',
        )
        .toArray()[0];
      const tokens = old
        ? Math.min(
            limits.burst,
            old.tokens +
              (Math.max(0, now - old.updated) * limits.requestsPerSecond) /
                1000,
          )
        : limits.burst;
      if (tokens < 1)
        throw new HttpError(
          429,
          'rate_limited',
          'Too many media operations. Retry after a short delay.',
          true,
          1,
        );
      this.ctx.storage.sql.exec(
        'INSERT INTO rate_bucket(id,tokens,updated) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET tokens=excluded.tokens,updated=excluded.updated',
        tokens - 1,
        now,
      );
      return null;
    });
  }
  async create(value: unknown): Promise<Outcome<Upload>> {
    return attempt(async () => {
      const input = validateInput(value);
      const limits = uploadLimits(this.env);
      const previous = this.ctx.storage.sql
        .exec<{ data: string }>(
          'SELECT data FROM uploads WHERE request_id=?',
          input.requestId,
        )
        .toArray()[0];
      if (previous) {
        const record = JSON.parse(previous.data) as RecordData;
        if (JSON.stringify(record.input) !== JSON.stringify(input))
          throw new HttpError(
            409,
            'request_conflict',
            'This request UUID already belongs to different input.',
          );
        return view(await this.reconcile(record));
      }
      // Reject missing signing or public-host configuration before accepting bytes.
      await fileURL(this.env, crypto.randomUUID(), Date.now() + INPUT_TTL_MS);
      // Resolve expired reservations before considering a new admission.
      await this.cleanup();
      const concurrent = this.ctx.storage.sql
        .exec<{ data: string }>(
          'SELECT data FROM uploads WHERE request_id=?',
          input.requestId,
        )
        .toArray()[0];
      if (concurrent) {
        const existing = JSON.parse(concurrent.data) as RecordData;
        if (JSON.stringify(existing.input) !== JSON.stringify(input))
          throw new HttpError(
            409,
            'request_conflict',
            'This request UUID already belongs to different input.',
          );
        return view(existing);
      }
      const now = Date.now();
      const record: RecordData = {
        id: crypto.randomUUID(),
        input,
        status: 'initializing',
        createdAt: now,
        uploadExpiresAt: now + UPLOAD_TTL_MS,
        deadline: now + UPLOAD_TTL_MS,
        reserved: true,
        parts: [],
      };
      this.ctx.storage.transactionSync(() => {
        const daily = this.ctx.storage.sql
          .exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM uploads WHERE created_at > ?',
            now - DAY,
          )
          .one().count;
        const totals = this.ctx.storage.sql
          .exec<{ bytes: number; unfinished: number }>(
            "SELECT COALESCE(SUM(size),0) AS bytes,COALESCE(SUM(CASE WHEN status != 'completed' THEN 1 ELSE 0 END),0) AS unfinished FROM uploads WHERE reserved=1",
          )
          .one();
        if (
          daily >= limits.uploadsPerDay ||
          totals.bytes + input.size > limits.maxBytes ||
          totals.unfinished >= limits.unfinished
        )
          throw new HttpError(
            429,
            'upload_quota_exceeded',
            'Temporary upload allowance exceeded. Wait for an unfinished upload or retained file to expire.',
            true,
            60,
          );
        this.save(record);
      });
      await this.schedule();
      try {
        const multipart = await this.env.MEDIA_BUCKET.createMultipartUpload(
          key(record),
          {
            httpMetadata: {
              contentType: input.contentType,
              cacheControl: 'private, no-store',
            },
            customMetadata: {
              uploadId: record.id,
              owner: this.ctx.id.toString(),
              sha256: input.sha256,
            },
          },
        );
        const current = this.read(record.id);
        if (current.status !== 'initializing') {
          await multipart.abort();
          return view(current);
        }
        current.multipartId = multipart.uploadId;
        current.status = 'uploading';
        this.save(current);
        return view(current);
      } catch (error) {
        const current = this.read(record.id);
        current.status = 'aborting';
        this.save(current);
        await this.cleanupRecord(current).catch(() => undefined);
        throw error;
      }
    });
  }
  async status(id: string): Promise<Outcome<Upload>> {
    return attempt(async () =>
      this.verifications.has(id)
        ? view(this.read(id))
        : view(await this.reconcile(this.read(id))),
    );
  }
  async beginPart(
    id: string,
    number: number,
    digest: string,
    length: number,
  ): Promise<Outcome<PartPermit>> {
    return attempt(async () => {
      await this.reconcile(this.read(id));
      const record = this.read(id);
      if (record.status !== 'uploading')
        throw new HttpError(
          409,
          'upload_not_writable',
          'This upload no longer accepts parts.',
        );
      if (
        !Number.isSafeInteger(number) ||
        number < 1 ||
        number > Math.ceil(record.input.size / PART_SIZE) ||
        !/^[a-f\d]{64}$/i.test(digest)
      )
        throw new HttpError(
          400,
          'invalid_part',
          'Supply a valid sequential part number and x-content-sha256 digest.',
        );
      const expected = Math.min(
        PART_SIZE,
        record.input.size - (number - 1) * PART_SIZE,
      );
      if (length !== expected)
        throw new HttpError(
          400,
          'invalid_part_size',
          'Content-Length must equal the expected part byte count.',
        );
      const accepted = record.parts.find((part) => part.number === number);
      if (accepted) {
        if (accepted.digest !== digest.toLowerCase())
          throw new HttpError(
            409,
            'part_conflict',
            'This part was already accepted with different bytes.',
          );
        return { upload: view(record) };
      }
      if (record.pending)
        throw new HttpError(
          409,
          'upload_busy',
          'A part is already being uploaded. Poll upload status before retrying.',
          true,
          1,
        );
      if (number !== record.parts.length + 1)
        throw new HttpError(
          409,
          'part_out_of_order',
          'Upload parts sequentially.',
        );
      if (!record.multipartId)
        throw new HttpError(
          503,
          'storage_unavailable',
          'The upload is not initialized.',
          true,
        );
      const operationId = crypto.randomUUID();
      record.pending = {
        operationId,
        number,
        digest: digest.toLowerCase(),
        deadline: Math.min(
          Date.now() + PART_TIMEOUT_MS,
          record.uploadExpiresAt,
        ),
      };
      record.deadline = record.pending.deadline;
      this.save(record);
      await this.schedule();
      return {
        upload: view(record),
        operationId,
        multipartId: record.multipartId,
        key: key(record),
        size: expected,
        contentType: record.input.contentType,
      };
    });
  }
  async finishPart(
    id: string,
    operationId: string,
    etag: string,
  ): Promise<Outcome<Upload>> {
    return attempt(async () => {
      const record = this.read(id);
      if (
        record.status !== 'uploading' ||
        record.pending?.operationId !== operationId ||
        record.pending.deadline <= Date.now()
      ) {
        if (
          record.status === 'uploading' &&
          record.pending?.operationId === operationId
        ) {
          record.status = 'aborting';
          this.save(record);
          await this.cleanupRecord(record);
        }
        throw new HttpError(
          409,
          'upload_interrupted',
          'This upload was interrupted. Start a new upload.',
          true,
        );
      }
      const pending = record.pending;
      record.parts.push({
        number: pending.number,
        etag,
        digest: pending.digest,
        size: Math.min(
          PART_SIZE,
          record.input.size - (pending.number - 1) * PART_SIZE,
        ),
      });
      delete record.pending;
      record.deadline = record.uploadExpiresAt;
      this.save(record);
      await this.schedule();
      return view(record);
    });
  }
  async failPart(id: string, operationId: string): Promise<Outcome<Upload>> {
    return attempt(async () => {
      const record = this.read(id);
      if (
        record.status === 'uploading' &&
        record.pending?.operationId === operationId
      ) {
        record.status = 'aborting';
        record.deadline = Date.now();
        this.save(record);
        await this.cleanupRecord(record);
      }
      await this.schedule();
      return view(this.read(id));
    });
  }
  async complete(id: string): Promise<Outcome<Upload>> {
    return attempt(async () => {
      const active = this.verifications.get(id);
      if (active) return view(await active);
      await this.reconcile(this.read(id));
      let record = this.read(id);
      if (record.status === 'completed') return view(record);
      if (record.status === 'uploading') {
        if (record.pending)
          throw new HttpError(
            409,
            'upload_busy',
            'Wait for the current part to finish.',
            true,
            1,
          );
        if (record.parts.length !== Math.ceil(record.input.size / PART_SIZE))
          throw new HttpError(
            409,
            'upload_incomplete',
            'Upload every part before completing.',
          );
        record.status = 'finalizing';
        record.deadline = Math.max(
          record.uploadExpiresAt,
          Date.now() + 5 * 60000,
        );
        this.save(record);
        await this.schedule();
      }
      if (record.status !== 'finalizing' || !record.multipartId)
        throw new HttpError(
          409,
          'upload_not_writable',
          'This upload cannot be completed.',
        );
      try {
        const completed = await this.env.MEDIA_BUCKET.resumeMultipartUpload(
          key(record),
          record.multipartId,
        ).complete(
          record.parts.map((part) => ({
            partNumber: part.number,
            etag: part.etag,
          })),
        );
        record = await this.finalized(record.id, completed);
      } catch (error) {
        const recovered = await this.recoverFinal(record);
        if (!recovered) throw error;
        record = recovered;
      }
      return view(record);
    });
  }
  async abort(id: string): Promise<Outcome<Upload>> {
    return attempt(async () => {
      const record = this.read(id);
      if (['completed', 'finalizing', 'expired'].includes(record.status))
        throw new HttpError(
          409,
          'upload_not_writable',
          'A finalized upload cannot be deleted early.',
        );
      if (record.status !== 'aborted') {
        record.status = 'aborting';
        record.deadline = Date.now();
        this.save(record);
        await this.cleanupRecord(record);
      }
      await this.schedule();
      return view(this.read(id));
    });
  }
  private finalized(id: string, object: R2Object): Promise<RecordData> {
    const existing = this.verifications.get(id);
    if (existing) return existing;
    const operation = Promise.resolve()
      .then(() => this.verifyAndFinalize(id, object))
      .finally(() => {
        if (this.verifications.get(id) === operation)
          this.verifications.delete(id);
      });
    this.verifications.set(id, operation);
    return operation;
  }
  private async verifyAndFinalize(
    id: string,
    object: R2Object,
  ): Promise<RecordData> {
    const record = this.read(id);
    if (record.status === 'completed') return record;
    if (
      record.status !== 'finalizing' ||
      object.size !== record.input.size ||
      object.customMetadata?.uploadId !== record.id ||
      object.customMetadata?.owner !== this.ctx.id.toString() ||
      object.customMetadata?.sha256 !== record.input.sha256 ||
      object.httpMetadata?.contentType !== record.input.contentType
    )
      throw new HttpError(
        503,
        'storage_unavailable',
        'The completed upload could not be verified.',
        true,
      );
    // Per-part integrity alone does not prove the original file stayed unchanged during upload.
    const stored = await this.env.MEDIA_BUCKET.get(key(record));
    if (!stored)
      throw new HttpError(
        503,
        'storage_unavailable',
        'The completed object is unavailable.',
        true,
      );
    const hash = createHash('sha256');
    const reader = stored.body.getReader();
    let bytes = 0;
    let verificationTimedOut = false;
    const timer = setTimeout(() => {
      verificationTimedOut = true;
      void reader.cancel().catch(() => undefined);
    }, 5 * 60000);
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        hash.update(item.value);
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
    if (verificationTimedOut || bytes !== record.input.size)
      throw new HttpError(
        503,
        'verification_unavailable',
        'File verification was interrupted. Retry completion.',
        true,
      );
    if (hash.digest('hex') !== record.input.sha256) {
      await this.env.MEDIA_BUCKET.delete(key(record));
      const invalid = this.read(id);
      invalid.status = 'aborted';
      invalid.reserved = false;
      this.save(invalid);
      await this.schedule();
      throw new HttpError(
        400,
        'checksum_mismatch',
        'The completed file does not match its original SHA-256 digest. Start a new upload.',
      );
    }
    // R2's completed-object timestamp survives response loss and process restarts.
    const completedAt = object.uploaded.getTime();
    const expiresAt = completedAt + INPUT_TTL_MS;
    const url = await fileURL(this.env, record.id, expiresAt);
    const current = this.read(id);
    if (current.status === 'completed') return current;
    if (current.status !== 'finalizing')
      throw new HttpError(
        409,
        'upload_interrupted',
        'Upload finalization was interrupted.',
        true,
      );
    current.status = 'completed';
    current.completedAt = completedAt;
    current.expiresAt = expiresAt;
    current.url = url;
    current.deadline = expiresAt;
    this.save(current);
    await this.schedule();
    return current;
  }
  private async recoverFinal(record: RecordData): Promise<RecordData | null> {
    const active = this.verifications.get(record.id);
    if (active) return active;
    const object = await this.env.MEDIA_BUCKET.head(key(record));
    return object ? this.finalized(record.id, object) : null;
  }
  private async reconcile(record: RecordData): Promise<RecordData> {
    if (record.status === 'finalizing') {
      if (this.verifications.has(record.id)) return this.read(record.id);
      const recovered = await this.recoverFinal(record);
      if (recovered) record = recovered;
    }
    if (record.reserved && record.deadline <= Date.now())
      await this.cleanupRecord(record);
    return this.read(record.id);
  }
  private async cleanupRecord(snapshot: RecordData): Promise<void> {
    let record = this.read(snapshot.id);
    if (!record.reserved) return;
    if (record.status === 'completed') {
      if ((record.expiresAt ?? Infinity) > Date.now()) return;
      await this.env.MEDIA_BUCKET.delete(key(record));
      record = this.read(record.id);
      record.status = 'expired';
      record.reserved = false;
      delete record.url;
      this.save(record);
      return;
    }
    if (record.status === 'finalizing') {
      const recovered = await this.recoverFinal(record);
      if (recovered) {
        if (recovered.deadline <= Date.now())
          await this.cleanupRecord(recovered);
        return;
      }
      if (record.deadline > Date.now()) return;
    } else if (record.status !== 'aborting' && record.deadline > Date.now())
      return;
    const wasFinalizing = record.status === 'finalizing';
    // Aborting the R2 upload fences every delayed part writer before releasing bytes.
    if (!wasFinalizing) {
      record.status = 'aborting';
      this.save(record);
    }
    if (record.multipartId) {
      try {
        await this.env.MEDIA_BUCKET.resumeMultipartUpload(
          key(record),
          record.multipartId,
        ).abort();
      } catch (error) {
        if (!isMissingUpload(error)) throw error;
      }
    }
    if (wasFinalizing) {
      const recovered = await this.recoverFinal(record);
      if (recovered) return;
    }
    record = this.read(record.id);
    if (record.status === 'completed') return;
    record.status = 'aborted';
    record.reserved = false;
    delete record.pending;
    this.save(record);
  }
  private async cleanup(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{ data: string }>(
        'SELECT data FROM uploads WHERE reserved=1 AND deadline <= ?',
        Date.now(),
      )
      .toArray();
    for (const row of rows) {
      const record = JSON.parse(row.data) as RecordData;
      try {
        await this.cleanupRecord(record);
      } catch {
        console.warn(
          JSON.stringify({
            event: 'media_cleanup_failed',
            code: 'storage_unavailable',
          }),
        );
        const current = this.read(record.id);
        current.deadline = Date.now() + 60000;
        this.save(current);
      }
    }
    this.ctx.storage.sql.exec(
      'DELETE FROM uploads WHERE reserved=0 AND created_at < ?',
      Date.now() - 7 * DAY,
    );
    await this.schedule();
  }
  async alarm(): Promise<void> {
    await this.cleanup();
  }
}
function isMissingUpload(error: unknown): boolean {
  return (
    error instanceof Error &&
    /NoSuchUpload|10024|does not exist|already.*abort/i.test(error.message)
  );
}
