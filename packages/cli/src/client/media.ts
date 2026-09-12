import { requestJson } from '../core/http.js';
import { CliError } from '../core/errors.js';
import type { CreateUpload, Upload } from '@spatius/contracts';

export interface MediaClientOptions {
  origin: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}
export class MediaClient {
  constructor(private readonly options: MediaClientOptions) {}
  async request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    timeoutMs = 30_000,
    signal = this.options.signal,
  ): Promise<T> {
    try {
      return await requestJson<T>(`${this.options.origin}${path}`, {
        method,
        body,
        headers: { authorization: `Bearer ${await this.options.token()}` },
        fetch: this.options.fetch,
        signal,
        retry: method === 'GET',
        timeoutMs,
      });
    } catch (error) {
      if (error instanceof CliError && error.code === 'upload_busy')
        error.options.retryable = true;
      throw error;
    }
  }
  create(body: CreateUpload) {
    return this.request<Upload>('/v1/uploads', 'POST', body);
  }
  get(id: string, signal?: AbortSignal) {
    return this.request<Upload>(
      `/v1/uploads/${id}`,
      'GET',
      undefined,
      30_000,
      signal ?? this.options.signal,
    );
  }
  complete(id: string) {
    return this.request<Upload>(
      `/v1/uploads/${id}/complete`,
      'POST',
      {},
      300_000,
    );
  }
  abort(id: string) {
    return this.request<Upload>(`/v1/uploads/${id}`, 'DELETE');
  }
  async part(
    id: string,
    number: number,
    bytes: Uint8Array,
    sha256: string,
  ): Promise<Upload> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(300_000),
      ...(this.options.signal ? [this.options.signal] : []),
    ]);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.options.origin}/v1/uploads/${id}/parts/${number}`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${await this.options.token()}`,
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.byteLength),
            'x-content-sha256': sha256,
          },
          body: bytes as BodyInit,
          redirect: 'error',
          signal,
        },
      );
    } catch {
      this.options.signal?.throwIfAborted();
      throw new CliError(
        'UPLOAD_TRANSPORT_ERROR',
        'The upload part response was not received.',
        { retryable: true },
      );
    }
    const text = await boundedText(response);
    if (!response.ok) {
      let code = 'UPLOAD_FAILED';
      try {
        const data = JSON.parse(text);
        if (
          typeof data?.error?.code === 'string' &&
          /^[a-zA-Z0-9_]+$/.test(data.error.code)
        )
          code = data.error.code;
      } catch {
        /* Do not print server text. */
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new CliError(
        code,
        'The temporary media service rejected the upload part.',
        {
          status: response.status,
          retryable:
            response.status === 429 ||
            response.status >= 500 ||
            code === 'upload_busy',
          ...(Number.isFinite(retryAfter) && retryAfter > 0
            ? { retryAfter }
            : {}),
        },
      );
    }
    try {
      return JSON.parse(text) as Upload;
    } catch {
      throw new CliError(
        'INVALID_RESPONSE',
        'The upload service returned an invalid response.',
        { retryable: true },
      );
    }
  }
}
export async function boundedText(
  response: Response,
  max = 1024 * 1024,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max)
        throw new CliError(
          'INVALID_RESPONSE',
          'The service response exceeded its size limit.',
        );
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
  }
}
