import type { ServiceError } from '@spatius/contracts';
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; body: ServiceError; retryAfter?: number };
export function failure(error: unknown): Exclude<Outcome<never>, { ok: true }> {
  const known =
    error instanceof HttpError
      ? error
      : new HttpError(
          503,
          'storage_unavailable',
          'Temporary media storage is unavailable. Retry this operation.',
          true,
        );
  console.warn(
    JSON.stringify({
      event: 'media_operation_failed',
      status: known.status,
      code: known.code,
    }),
  );
  return {
    ok: false,
    status: known.status,
    body: {
      error: {
        code: known.code,
        message: known.message,
        retryable: known.retryable,
      },
    },
    ...(known.retryAfter === undefined ? {} : { retryAfter: known.retryAfter }),
  };
}
export async function attempt<T>(
  operation: () => T | Promise<T>,
): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return failure(error);
  }
}
export function outcomeResponse<T>(
  outcome: Outcome<T>,
  status = 200,
): Response {
  if (outcome.ok)
    return Response.json(outcome.value, {
      status,
      headers: { 'Cache-Control': 'no-store' },
    });
  return Response.json(outcome.body, {
    status: outcome.status,
    headers: {
      'Cache-Control': 'no-store',
      ...(outcome.retryAfter === undefined
        ? {}
        : { 'Retry-After': String(outcome.retryAfter) }),
    },
  });
}
export async function boundedJSON(
  request: Request | Response,
  maximum = 16384,
): Promise<unknown> {
  if (!request.body)
    throw new HttpError(400, 'invalid_request', 'A JSON body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum)
        throw new HttpError(
          413,
          'request_too_large',
          'The JSON body is too large.',
        );
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new HttpError(
        400,
        'invalid_request',
        'The body must be valid JSON.',
      );
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'invalid_request', 'A JSON object is required.');
  return value as Record<string, unknown>;
}
