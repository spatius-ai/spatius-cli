import { boundedJSON, HttpError, object } from './errors.js';

type AuthFailureReason =
  | 'configuration'
  | 'timeout'
  | 'network'
  | 'status'
  | 'invalid_json'
  | 'identity';
type AuthPhase = 'configuration' | 'request' | 'body' | 'identity';
function contentCategory(response: Response): string {
  const type = response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (!type) return 'missing';
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type === 'text/html') return 'html';
  if (type.startsWith('text/')) return 'text';
  return 'other';
}
export async function authenticate(
  request: Request,
  env: Env,
): Promise<string> {
  const authorization = request.headers.get('authorization') ?? '';
  if (!/^Bearer [^\s]{1,8192}$/i.test(authorization))
    throw new HttpError(
      401,
      'unauthenticated',
      'Sign in to Spatius Studio to upload files.',
    );
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let phase: AuthPhase = 'configuration';
  let reason: AuthFailureReason | undefined;
  let upstreamStatus: number | undefined;
  let upstreamContentType: string | undefined;
  try {
    const endpoint = new URL('/v1/auth/me', env.STUDIO_API_URL);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password
    )
      throw new HttpError(
        503,
        'service_unavailable',
        'Studio authentication is not configured.',
        true,
      );
    phase = 'request';
    const response = await fetch(endpoint, {
      headers: { Authorization: authorization, Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    });
    upstreamStatus = response.status;
    upstreamContentType = contentCategory(response);
    if (response.status === 401 || response.status === 403) {
      reason = 'status';
      await response.body?.cancel();
      throw new HttpError(
        401,
        'unauthenticated',
        'Your Studio login has expired. Sign in again.',
      );
    }
    if (!response.ok) {
      reason = 'status';
      await response.body?.cancel();
      throw new HttpError(
        503,
        'auth_unavailable',
        'Studio authentication is temporarily unavailable.',
        true,
      );
    }
    phase = 'body';
    const decoded = await boundedJSON(response, 65536);
    phase = 'identity';
    const body = object(decoded);
    if (body.error !== undefined && body.error !== null)
      throw new HttpError(
        503,
        'auth_unavailable',
        'Studio returned an invalid identity.',
        true,
      );
    const user = object(body.user);
    if (typeof user.id !== 'string' || !user.id || user.id.length > 256)
      throw new HttpError(
        503,
        'auth_unavailable',
        'Studio returned an invalid identity.',
        true,
      );
    return user.id;
  } catch (error) {
    reason ??= controller.signal.aborted
      ? 'timeout'
      : phase === 'configuration'
        ? 'configuration'
        : phase === 'body'
          ? 'invalid_json'
          : phase === 'identity'
            ? 'identity'
            : 'network';
    console.warn(
      JSON.stringify({
        event: 'media_auth_failed',
        reason,
        phase,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
        ...(upstreamContentType === undefined ? {} : { upstreamContentType }),
      }),
    );
    if (
      error instanceof HttpError &&
      ['unauthenticated', 'auth_unavailable', 'service_unavailable'].includes(
        error.code,
      )
    )
      throw error;
    throw new HttpError(
      503,
      'auth_unavailable',
      'Studio authentication is temporarily unavailable.',
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
}
