// Studio's browser/PKCE protocol follows create-spatius-app (MIT, spatialwalk 2026).
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { CliError } from '../core/errors.js';
import { type ObjectValue, StudioClient, string } from './client.js';

export interface LoginOptions {
  noBrowser?: boolean;
  timeoutMs?: number;
  onAuthorize?: (url: string) => void;
  signal?: AbortSignal;
}

export async function browserLogin(
  client: StudioClient,
  studioWebOrigin: string,
  options: LoginOptions,
): Promise<ObjectValue> {
  if (options.signal?.aborted)
    throw new CliError('INTERRUPTED', 'Login was interrupted.', {
      exitCode: 130,
    });
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(18).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let redirectUri: URL;
  let requestId = '';
  let complete: (code: string) => void = () => undefined;
  let reject: (error: CliError) => void = () => undefined;
  const callback = new Promise<string>((resolve, fail) => {
    complete = resolve;
    reject = fail;
  });
  void callback.catch(() => undefined);
  let settled = false;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    if (
      request.method !== 'GET' ||
      request.headers.host !== redirectUri.host ||
      !request.url ||
      settled
    ) {
      response.writeHead(404).end('Not found');
      return;
    }
    const url = new URL(request.url, redirectUri);
    const query = url.searchParams;
    if (url.origin !== redirectUri.origin || url.pathname !== '/callback') {
      response.writeHead(404).end('Not found');
      return;
    }
    if (
      query.getAll('state').length !== 1 ||
      query.get('state') !== state ||
      query.getAll('auth_request_id').length !== 1 ||
      query.get('auth_request_id') !== requestId
    ) {
      response.writeHead(400).end('Invalid authorization callback.');
      return;
    }
    if (query.has('error')) {
      settled = true;
      response
        .writeHead(400)
        .end('Authorization was declined. Return to your terminal.');
      reject(
        new CliError('AUTH_DECLINED', 'Studio authorization was declined.'),
      );
      return;
    }
    const code = query.get('auth_code');
    if (!code || query.getAll('auth_code').length !== 1) {
      response.writeHead(400).end('Invalid authorization callback.');
      return;
    }
    settled = true;
    response
      .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Spatius authorization received. Return to your terminal.');
    complete(code);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () =>
    reject(
      new CliError('INTERRUPTED', 'Login was interrupted.', { exitCode: 130 }),
    );
  try {
    await new Promise<void>((resolve, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', fail);
        resolve();
      });
    }).catch(() => {
      throw new CliError(
        'AUTH_CALLBACK_UNAVAILABLE',
        'The local login callback listener could not be started.',
        {
          recovery:
            'Allow local loopback connections, then run spatius auth login again.',
        },
      );
    });
    redirectUri = new URL(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
    );
    const session = await client.request('/v1/cli/auth/sessions', {
      body: {
        clientName: 'Spatius CLI',
        codeChallenge: challenge,
        codeChallengeMethod: 'CLI_AUTH_CODE_CHALLENGE_METHOD_S256',
        redirectUri: redirectUri.href,
        state,
      },
      signal: options.signal,
    });
    requestId = string(session, 'authRequestId');
    const authorizeUrl = new URL(string(session, 'authorizeUrl'));
    if (
      authorizeUrl.origin !== studioWebOrigin ||
      authorizeUrl.username ||
      authorizeUrl.password ||
      authorizeUrl.pathname !== `/cli/auth/${encodeURIComponent(requestId)}`
    ) {
      throw new CliError(
        'UNSAFE_AUTH_URL',
        'Studio returned an unexpected authorization URL.',
      );
    }
    const expiresAt =
      typeof session.expiresAt === 'string'
        ? Date.parse(session.expiresAt) - Date.now()
        : Number.POSITIVE_INFINITY;
    const expiresIn =
      typeof session.expiresIn === 'number' && session.expiresIn > 0
        ? session.expiresIn * 1000
        : Number.POSITIVE_INFINITY;
    const requested = options.timeoutMs ?? 5 * 60_000;
    if (!Number.isFinite(requested) || requested <= 0)
      throw new CliError('INVALID_ARGUMENT', 'Login timeout must be positive.');
    const milliseconds = Math.max(
      1,
      Math.min(
        requested,
        10 * 60_000,
        Number.isFinite(expiresAt) ? expiresAt : Infinity,
        expiresIn,
      ),
    );
    timeout = setTimeout(
      () =>
        reject(
          new CliError(
            'AUTH_TIMEOUT',
            'Timed out waiting for Studio authorization.',
            { recovery: 'Run spatius auth login again.' },
          ),
        ),
      milliseconds,
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    options.onAuthorize?.(authorizeUrl.href);
    if (!options.noBrowser) {
      const executable =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'rundll32.exe'
            : 'xdg-open';
      const args =
        process.platform === 'win32'
          ? ['url.dll,FileProtocolHandler', authorizeUrl.href]
          : [authorizeUrl.href];
      // The printed URL remains usable when an agent session cannot launch a browser.
      await promisify(execFile)(executable, args, {
        timeout: 10_000,
        windowsHide: true,
      }).catch(() => undefined);
    }
    const authCode = await callback;
    return await client.request('/v1/cli/auth/token', {
      body: { authRequestId: requestId, authCode, codeVerifier: verifier },
      signal: options.signal,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
