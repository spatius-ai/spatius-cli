import { HttpError } from './errors.js';
export function uploadLimits(env: Env) {
  const positiveInteger = (value: string): number => {
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1)
      throw new HttpError(
        503,
        'service_unavailable',
        'Temporary media limits are not configured correctly.',
        true,
      );
    return number;
  };
  return {
    maxBytes: positiveInteger(env.MAX_STORED_BYTES),
    uploadsPerDay: positiveInteger(env.MAX_UPLOADS_PER_DAY),
    unfinished: positiveInteger(env.MAX_UNFINISHED_UPLOADS),
    requestsPerSecond: positiveInteger(env.REQUESTS_PER_SECOND),
    burst: positiveInteger(env.REQUEST_BURST),
  };
}
