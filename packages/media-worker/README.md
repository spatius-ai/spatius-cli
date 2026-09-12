# Temporary media Worker

This service turns local CLI files into temporary URLs accepted by the Spatius Avatar and Video APIs. Upload management requires a current Studio session. Read links are bearer capabilities so the console downloader can fetch the file without forwarding login credentials; the R2 bucket itself stays private.

## Protocol

All management calls use `Authorization: Bearer <Studio login token>`. Successful responses are the shared `Upload` object. Failures use `{ "error": { "code", "message", "retryable" } }`; throttled calls also return `Retry-After`.

| Method / path                         | Behavior                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/uploads`                    | Accept `{ requestId, kind, contentType, size, sha256 }`. The UUID deduplicates identical input for the metadata retention period; different input conflicts. |
| `GET /v1/uploads/{id}`                | Read owned state and accepted parts, including the original URL after completion.                                                                            |
| `PUT /v1/uploads/{id}/parts/{number}` | Send binary bytes with exact `Content-Length` and required `x-content-sha256`. Parts are sequential, 8 MiB except the last.                                  |
| `POST /v1/uploads/{id}/complete`      | Finalize the server's manifest and verify the whole-file SHA-256 before publishing its URL.                                                                  |
| `DELETE /v1/uploads/{id}`             | Abort an unfinished upload. A finalized file cannot be removed early.                                                                                        |
| `GET/HEAD /v1/files/{id}?…`           | Read using the signed URL returned at completion.                                                                                                            |
| `GET /health`                         | Process health; does not verify login or cloud configuration.                                                                                                |

The Worker validates every management call with `GET https://api.studio.spatius.ai/v1/auth/me`, using a five-second deadline and rejecting redirects. It stores the trusted user identity through the per-user Durable Object name, never the login token or an Open API key. Upload access does not change existing Open API access policies.

Each user can reserve/retain **2 GiB**, admit **100 new uploads per rolling 24 hours**, and have **10 unfinished uploads**. Management operations share a token bucket of **10 requests/second, burst 20**. Deployments configure these positive integer values through `MAX_STORED_BYTES`, `MAX_UPLOADS_PER_DAY`, `MAX_UNFINISHED_UPLOADS`, `REQUESTS_PER_SECOND`, and `REQUEST_BURST`; missing or invalid settings deny operations. Duplicate admissions do not consume another upload allowance. Aborts release byte reservations after storage cleanup, but do not refund the daily admission count.

## Recovery and retention

Only one part may be in flight per upload. `upload_busy` means to poll state; an already accepted matching part can be retried. A part interrupted before its acknowledgement was persisted is aborted rather than replaced by a competing writer. Resume the CLI operation to discover the saved state; an aborted upload needs a new upload request UUID.

Finalization freezes the manifest. Lost completion responses recover from the unique R2 object's identity, size, MIME, and checksum. The exact final URL and timestamps are saved and replayed. A file is available for **24 hours from R2 completion**, with no renewal. Unfinished uploads expire after **one hour**; an individual part has a two-minute transfer deadline. Metadata and request-ID deduplication records are retained for seven days from admission.

Durable Object alarms abort unfinished uploads and delete expired files. Reservations remain held until cleanup succeeds; failures schedule another attempt. Signed URLs reject access at their exact expiry independently of physical deletion. R2 lifecycle rules provide a fallback after two days for objects and one day for incomplete multipart uploads. The extra object day prevents lifecycle rules from shortening the advertised availability window.

Keep completed URLs unchanged when retrying an uncertain Open API submission. In particular, uploading the file again would change the Video API's normalized request body and conflict with its original retry UUID.

## Development and deployment

From the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @spatius/media-worker typegen
pnpm --filter @spatius/media-worker typecheck
pnpm --filter @spatius/media-worker test
pnpm --filter @spatius/media-worker build
```

The tests use real local Worker, R2, and SQLite Durable Object bindings, including a streaming 500 MiB upload. `build` is a production configuration dry run; it does not deploy.

For local development, copy `.dev.vars.example` to `.dev.vars`, replace the example secret with at least 32 random characters, and run `pnpm --filter @spatius/media-worker dev`. The production runtime never falls back to an example secret.

Before deploying an environment:

1. Create the environment's R2 bucket from `wrangler.jsonc`. Keep public bucket access disabled. Staging and production must have separate buckets and Durable Object namespaces.
2. Set that environment's `PUBLIC_URL` to the actual HTTPS Worker hostname. Production anticipates `https://cli-media.spatius.ai`; staging intentionally uses an invalid placeholder until its hostname is selected. Configure the custom Worker domain in Cloudflare when using these names.
3. Set `SIGNING_KEYS` with `wrangler secret put SIGNING_KEYS --env <environment>`. Its value is a JSON map such as `{ "v1": "<random secret>" }`; `SIGNING_KEY_ID` selects the active key. Keep previous keys available for at least 24 hours after issuing their last URL. Never put signing secrets in `wrangler.jsonc`.
4. Apply the lifecycle fallback to the newly created dedicated bucket with `wrangler r2 bucket lifecycle set <bucket> --file lifecycle.json`. This file is the complete lifecycle configuration for that dedicated bucket.
5. Run `pnpm --filter @spatius/media-worker deploy:staging` or `deploy:production` only for the intended environment. The SQLite Durable Object migration runs with deployment.

Wrangler invocation logs are disabled to avoid recording signed URLs or authentication material. Do not add request/header/body dumps or enable invocation logging for production media routes. Monitor Cloudflare request failures, R2 usage, and cleanup failures through sanitized metrics; do not use file URLs as metric labels.

A staging smoke test should sign in through Studio, upload a small valid portrait and a real WAV file through the CLI, create/poll an Avatar and Video job, then download the MP4. Verify that the Avatar source can be fetched within its three-second backend deadline. Also check that an unauthenticated upload is rejected and that a signed URL remains unchanged after polling completion again. Never put smoke-test tokens or generated signed URLs into committed fixtures.
