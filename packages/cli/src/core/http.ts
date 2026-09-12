import { setTimeout as delay } from 'node:timers/promises';
import { CliError } from './errors.js';

export interface JsonRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  retry?: boolean;
  timeoutMs?: number;
}

export async function readJson(
  response: Response,
  maxBytes = 2 * 1024 * 1024,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new CliError(
      'INVALID_RESPONSE',
      'The service returned an empty response.',
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new CliError(
          'INVALID_RESPONSE',
          'The service response exceeded the size limit.',
        );
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CliError) throw error;
    throw new CliError(
      'INVALID_RESPONSE',
      'The service returned invalid JSON.',
    );
  } finally {
    reader.releaseLock();
  }
}

export function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const result = Number.isFinite(seconds)
    ? seconds
    : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(result) ? Math.max(0, Math.ceil(result)) : undefined;
}

export async function requestJson<T>(
  url: string,
  options: JsonRequest = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const retries = (options.retry ?? method === 'GET') ? 3 : 0;
  const send = options.fetch ?? globalThis.fetch;
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let failure: CliError;
    try {
      const response = await send(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(options.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        redirect: 'error',
        signal,
      });
      if (response.ok) return (await readJson(response)) as T;
      const status = response.status;
      let code = `HTTP_${status}`;
      try {
        const data = (await readJson(response, 64 * 1024)) as {
          error?: { code?: unknown };
        };
        if (
          typeof data?.error?.code === 'string' &&
          /^[a-zA-Z0-9_.-]{1,100}$/.test(data.error.code)
        )
          code = data.error.code;
      } catch {
        /* Never expose untrusted error bodies. */
      }
      const requestId = response.headers.get('x-request-id');
      failure = new CliError(
        code,
        `The service rejected the request (HTTP ${status}).`,
        {
          status,
          retryable: status === 429 || status >= 500,
          retryAfter: retryAfterSeconds(response.headers.get('retry-after')),
          recovery:
            status === 401
              ? 'Run spatius auth login or spatius setup to restore credentials.'
              : status === 403
                ? 'Ask an administrator to verify API access and avatar permissions for this account.'
                : status === 402
                  ? 'Check your Avatar Creations balance in Studio.'
                  : status === 409
                    ? 'Reuse the original request input or explicitly start a new operation.'
                    : 'Inspect the operation state before retrying a creation.',
          ...(requestId && /^[a-zA-Z0-9_-]{1,100}$/.test(requestId)
            ? { details: { requestId } }
            : {}),
        },
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      failure =
        error instanceof CliError
          ? error
          : new CliError(
              'NETWORK_ERROR',
              'The service request did not complete.',
              {
                retryable: true,
                recovery:
                  'Check connectivity. Resume a saved creation instead of creating again.',
              },
            );
    }
    if (attempt >= retries || !failure.options.retryable) throw failure;
    const waitSeconds = failure.options.retryAfter ?? Math.min(8, 2 ** attempt);
    // Long rate-limit waits should be scheduled by the caller, not hidden here.
    if (waitSeconds > 30) throw failure;
    await delay(waitSeconds * 1000, undefined, { signal: options.signal });
  }
}
