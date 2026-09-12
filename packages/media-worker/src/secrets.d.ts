interface Env {
  /** JSON object of key ID -> >=32-character HMAC secret; use wrangler secret put. */
  SIGNING_KEYS: string;
}
declare namespace Cloudflare {
  interface Env {
    SIGNING_KEYS: string;
  }
}
