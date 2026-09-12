import { createHash } from 'node:crypto';
import { UUID_PATTERN, matchesMediaSignature } from '@spatius/contracts';
import { authenticate } from './auth.js';
import {
  PART_TIMEOUT_MS,
  UploadCoordinator,
  type PartPermit,
} from './coordinator.js';
import {
  attempt,
  boundedJSON,
  failure,
  HttpError,
  outcomeResponse,
} from './errors.js';
import { verifyFileURL } from './signing.js';
export { UploadCoordinator };

async function streamPart(
  request: Request,
  env: Env,
  permit: PartPermit,
  number: number,
  digest: string,
): Promise<string> {
  if (
    !request.body ||
    permit.size === undefined ||
    !permit.key ||
    !permit.multipartId ||
    !permit.contentType
  )
    throw new HttpError(400, 'invalid_part', 'A binary part body is required.');
  if (
    request.headers.has('content-encoding') &&
    request.headers.get('content-encoding') !== 'identity'
  )
    throw new HttpError(
      400,
      'invalid_part',
      'Encoded upload bodies are not supported.',
    );
  const reader = request.body.getReader();
  const bounded = new FixedLengthStream(permit.size);
  const writer = bounded.writable.getWriter();
  const hash = createHash('sha256');
  const prefix = new Uint8Array(16);
  let prefixLength = 0;
  let length = 0;
  let cancelled = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancelled = true;
    cancellation ??= Promise.all([
      reader.cancel().catch(() => undefined),
      writer.abort().catch(() => undefined),
    ]).then(() => undefined);
    return cancellation;
  };
  const onAbort = () => {
    void cancel();
  };
  const timer = setTimeout(onAbort, PART_TIMEOUT_MS);
  request.signal.addEventListener('abort', onAbort, { once: true });
  const pump = (async () => {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > permit.size!)
        throw new HttpError(
          413,
          'part_too_large',
          'The part exceeds its expected byte count.',
        );
      hash.update(item.value);
      const prefixBytes = item.value.subarray(0, prefix.length - prefixLength);
      prefix.set(prefixBytes, prefixLength);
      prefixLength += prefixBytes.length;
      await writer.write(item.value);
    }
    if (cancelled)
      throw new HttpError(
        408,
        'upload_interrupted',
        'The part transfer was interrupted. Start a new upload.',
        true,
      );
    if (length !== permit.size)
      throw new HttpError(
        400,
        'invalid_part_size',
        'The part ended before its expected byte count.',
      );
    if (hash.digest('hex') !== digest.toLowerCase())
      throw new HttpError(
        400,
        'checksum_mismatch',
        'The part does not match x-content-sha256.',
      );
    if (
      number === 1 &&
      !matchesMediaSignature(
        permit.contentType!,
        prefix.subarray(0, prefixLength),
      )
    )
      throw new HttpError(
        400,
        'unsupported_media_type',
        'The file signature does not match its declared media type.',
      );
    await writer.close();
  })();
  const uploaded = env.MEDIA_BUCKET.resumeMultipartUpload(
    permit.key,
    permit.multipartId,
  ).uploadPart(number, bounded.readable);
  try {
    const [part] = await Promise.all([uploaded, pump]);
    return part.etag;
  } catch (error) {
    await cancel();
    await Promise.allSettled([uploaded, pump]);
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    await cancellation;
    reader.releaseLock();
    writer.releaseLock();
  }
}
async function serveFile(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  await verifyFileURL(env, new URL(request.url));
  const object =
    request.method === 'HEAD'
      ? await env.MEDIA_BUCKET.head(`media/${id}`)
      : await env.MEDIA_BUCKET.get(`media/${id}`);
  if (!object) throw new HttpError(404, 'upload_not_found', 'File not found.');
  const headers = new Headers({
    'Content-Type':
      object.httpMetadata?.contentType ?? 'application/octet-stream',
    'Content-Length': String(object.size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'attachment',
    ETag: object.httpEtag,
  });
  return new Response(
    'body' in object && object.body instanceof ReadableStream
      ? object.body
      : null,
    { headers },
  );
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET')
        return Response.json({ status: 'ok' });
      const file = /^\/v1\/files\/([^/]+)$/.exec(path);
      if (file) {
        if (!UUID_PATTERN.test(file[1]!))
          throw new HttpError(404, 'upload_not_found', 'File not found.');
        if (!['GET', 'HEAD'].includes(request.method))
          throw new HttpError(
            405,
            'method_not_allowed',
            'Only GET and HEAD are supported.',
          );
        return await serveFile(request, env, file[1]!);
      }
      const route =
        /^\/v1\/uploads(?:\/([^/]+)(?:\/(complete|parts\/([^/]+)))?)?$/.exec(
          path,
        );
      if (!route || (route[1] && !UUID_PATTERN.test(route[1])))
        throw new HttpError(404, 'not_found', 'Route not found.');
      const userId = await authenticate(request, env);
      const owner = env.UPLOADS.getByName(userId);
      const rate = await owner.rateLimit();
      if (!rate.ok) return outcomeResponse(rate);
      const id = route[1];
      if (!id && request.method === 'POST')
        return outcomeResponse(
          await owner.create(await boundedJSON(request)),
          201,
        );
      if (id && !route[2]) {
        if (request.method === 'GET')
          return outcomeResponse(await owner.status(id));
        if (request.method === 'DELETE')
          return outcomeResponse(await owner.abort(id));
      }
      if (id && route[2] === 'complete' && request.method === 'POST')
        return outcomeResponse(await owner.complete(id));
      if (id && route[3] && request.method === 'PUT') {
        const number = Number(route[3]);
        const digest = request.headers.get('x-content-sha256') ?? '';
        const contentLength = request.headers.get('content-length');
        if (contentLength === null || !/^\d+$/.test(contentLength))
          throw new HttpError(
            411,
            'length_required',
            'Content-Length is required for each part.',
          );
        const permitted = await owner.beginPart(
          id,
          number,
          digest,
          Number(contentLength),
        );
        if (!permitted.ok) return outcomeResponse(permitted);
        const permit = permitted.value;
        if (!permit.operationId)
          return Response.json(permit.upload, {
            headers: { 'Cache-Control': 'no-store' },
          });
        try {
          const etag = await streamPart(request, env, permit, number, digest);
          return outcomeResponse(
            await owner.finishPart(id, permit.operationId, etag),
          );
        } catch (error) {
          await owner.failPart(id, permit.operationId).catch(() => undefined);
          throw error;
        }
      }
      throw new HttpError(
        405,
        'method_not_allowed',
        'This method is not supported for this route.',
      );
    } catch (error) {
      return outcomeResponse(failure(error));
    }
  },
} satisfies ExportedHandler<Env>;
// Keep the stream implementation accessible to runtime tests without exposing another HTTP route.
export const testable = { streamPart, attempt };
