import { CliError } from '../core/errors.js';

export type ObjectValue = Record<string, unknown>;

export function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidResponse();
  return value as ObjectValue;
}

export function string(value: ObjectValue, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result.trim()) throw invalidResponse();
  return result;
}

export function invalidResponse(): CliError {
  return new CliError(
    'STUDIO_INVALID_RESPONSE',
    'Studio returned an invalid response.',
    { retryable: true },
  );
}

const errorStatuses: Record<string, number> = {
  UNAUTHORIZED: 401,
  unauthorized: 401,
  FORBIDDEN: 403,
  PERMISSION_DENIED: 403,
  forbidden: 403,
  NOT_FOUND: 404,
  not_found: 404,
  INVALID_ARGUMENT: 400,
  invalid_request: 400,
  QUOTA_EXCEEDED: 429,
  ALREADY_EXISTS: 409,
  UNAVAILABLE: 503,
  INTERNAL_SERVER_ERROR: 500,
};

export class StudioClient {
  constructor(
    private readonly origin: string,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async request(
    path: string,
    options: { token?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<ObjectValue> {
    const method = options.body === undefined ? 'GET' : 'POST';
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.origin), {
        method,
        headers: {
          Accept: 'application/json',
          ...(options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}),
          ...(options.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        redirect: 'error',
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      if (options.signal?.aborted)
        throw new CliError('INTERRUPTED', 'Login was interrupted.', {
          exitCode: 130,
        });
      throw new CliError(
        'STUDIO_UNAVAILABLE',
        'The Studio request could not be completed.',
        {
          retryable: method === 'GET',
          recovery:
            'Check your connection and retry a read. Reconcile setup before retrying a creation.',
        },
      );
    }
    let payload: ObjectValue;
    try {
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > 2 * 1024 * 1024) throw invalidResponse();
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      }
      const text = Buffer.concat(chunks).toString('utf8');
      payload = text.trim() ? object(JSON.parse(text)) : {};
    } catch {
      if (!response.ok) throw this.httpError(response.status);
      throw invalidResponse();
    }
    const errors = payload.errors;
    const raw =
      Array.isArray(errors) && errors.length ? errors[0] : payload.error;
    if (raw !== undefined && raw !== null) {
      const detail = typeof raw === 'object' ? (raw as ObjectValue) : {};
      const number = Number(detail.status);
      const status =
        Number.isInteger(number) && number >= 400 && number <= 599
          ? number
          : (errorStatuses[String(detail.code)] ??
            (response.ok ? 500 : response.status));
      throw this.httpError(status);
    }
    if (!response.ok) throw this.httpError(response.status);
    return payload;
  }

  private httpError(status: number): CliError {
    return new CliError(
      status === 401
        ? 'AUTH_REQUIRED'
        : status === 403
          ? 'STUDIO_FORBIDDEN'
          : status === 404
            ? 'STUDIO_NOT_FOUND'
            : 'STUDIO_ERROR',
      status === 401
        ? 'Your Studio login is no longer valid.'
        : `Studio rejected the request (HTTP ${status}).`,
      {
        status,
        retryable: status === 429 || status >= 500,
        ...(status === 401 ? { recovery: 'Run spatius auth login.' } : {}),
      },
    );
  }
}
