import { CliError } from '../core/errors.js';
import { requestJson } from '../core/http.js';

export interface SessionTokenInput {
  expireAt: number;
  modelVersion: string;
}

/** Matches the Studio app detail page's Console token request. */
export class SessionTokenClient {
  constructor(
    private readonly origin: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly signal?: AbortSignal,
  ) {}

  async create(apiKey: string, input: SessionTokenInput): Promise<string> {
    try {
      const result = await requestJson<{
        sessionToken?: unknown;
        error?: unknown;
        errors?: unknown;
      }>(new URL('/v1/console/session-tokens', this.origin).href, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey },
        body: input,
        fetch: this.fetcher,
        signal: this.signal,
        retry: false,
      });
      if (
        !result ||
        result.error ||
        (Array.isArray(result.errors) && result.errors.length) ||
        typeof result.sessionToken !== 'string' ||
        !result.sessionToken.trim()
      )
        throw new CliError(
          'SESSION_TOKEN_INVALID_RESPONSE',
          'Console did not return a session token.',
        );
      return result.sessionToken;
    } catch (error) {
      if (this.signal?.aborted)
        throw new CliError(
          'INTERRUPTED',
          'Session-token generation was interrupted.',
          { exitCode: 130 },
        );
      // Backend codes, messages, and request IDs can contain credentials.
      const status =
        error instanceof CliError ? error.options.status : undefined;
      throw new CliError(
        'SESSION_TOKEN_FAILED',
        status
          ? `Console rejected session-token generation (HTTP ${status}).`
          : 'Session-token generation did not complete safely.',
        { status, retryable: false },
      );
    }
  }
}
