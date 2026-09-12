import { HttpError } from './errors.js';
const encoder = new TextEncoder();
async function signingKey(env: Env, id: string): Promise<CryptoKey> {
  let keys: unknown;
  try {
    keys = JSON.parse(env.SIGNING_KEYS) as unknown;
  } catch {
    throw new HttpError(
      503,
      'service_unavailable',
      'Temporary media storage is not configured.',
      true,
    );
  }
  if (keys === null || typeof keys !== 'object' || !(id in keys))
    throw new HttpError(403, 'invalid_signature', 'The file link is invalid.');
  const secret: unknown = Reflect.get(keys, id);
  if (typeof secret !== 'string' || secret.length < 32)
    throw new HttpError(
      503,
      'service_unavailable',
      'Temporary media storage is not configured.',
      true,
    );
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
function message(path: string, expires: string, kid: string): Uint8Array {
  return encoder.encode(`spatius-media-read-v1\n${path}\n${expires}\n${kid}`);
}
export async function fileURL(
  env: Env,
  id: string,
  expiresAt: number,
): Promise<string> {
  const base = new URL(env.PUBLIC_URL);
  if (
    base.hostname.endsWith('.invalid') ||
    (base.protocol !== 'https:' &&
      !(
        base.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      )) ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search !== '' ||
    base.hash !== ''
  )
    throw new HttpError(
      503,
      'service_unavailable',
      'The public media URL is not configured.',
      true,
    );
  const url = new URL(`/v1/files/${id}`, base);
  const expires = String(expiresAt);
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(env, env.SIGNING_KEY_ID),
    message(url.pathname, expires, env.SIGNING_KEY_ID),
  );
  url.searchParams.set('expires', expires);
  url.searchParams.set('kid', env.SIGNING_KEY_ID);
  url.searchParams.set('signature', Buffer.from(signature).toString('hex'));
  return url.toString();
}
export async function verifyFileURL(
  env: Env,
  url: URL,
  now = Date.now(),
): Promise<void> {
  const expires = url.searchParams.get('expires') ?? '';
  const kid = url.searchParams.get('kid') ?? '';
  const signature = url.searchParams.get('signature') ?? '';
  if (
    !/^\d{13}$/.test(expires) ||
    !/^[a-zA-Z0-9_-]{1,32}$/.test(kid) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    throw new HttpError(403, 'invalid_signature', 'The file link is invalid.');
  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(env, kid),
    Buffer.from(signature, 'hex'),
    message(url.pathname, expires, kid),
  );
  if (!valid)
    throw new HttpError(403, 'invalid_signature', 'The file link is invalid.');
  if (Number(expires) <= now)
    throw new HttpError(410, 'upload_expired', 'The file link has expired.');
}
