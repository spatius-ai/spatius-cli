# Temporary media service deployment

Deploy the Worker in `packages/media-worker`. It uses one private R2 bucket and
one SQLite Durable Object per Studio user. No Console signing secret, renderer
token, app API key, or Studio refresh token belongs in this service.

## Configuration

| Setting                                | Purpose                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `STUDIO_API_URL`                       | Trusted Studio origin for online `GET /v1/auth/me` validation              |
| `PUBLIC_URL`                           | Actual HTTPS origin serving this Worker; used to sign immutable input URLs |
| `SIGNING_KEY_ID`                       | Active key ID for new read links                                           |
| `SIGNING_KEYS` (secret)                | JSON map of key IDs to random secrets of at least 32 characters            |
| `MAX_STORED_BYTES`                     | Per-user reserved/retained byte limit; default 2 GiB                       |
| `MAX_UPLOADS_PER_DAY`                  | New uploads per rolling day; default 100                                   |
| `MAX_UNFINISHED_UPLOADS`               | Unfinished uploads per user; default 10                                    |
| `REQUESTS_PER_SECOND`, `REQUEST_BURST` | Management-operation token bucket; default 10 and 20                       |

Staging and production have separate Worker names, buckets, and DO namespaces.
Set the Cloudflare account using the intended Wrangler profile or
`CLOUDFLARE_ACCOUNT_ID`. Verify `pnpm exec wrangler whoami` before provisioning.
The staging Worker uses `https://spatius-cli-media-staging.472617147.workers.dev`.
Set the CLI's `SPATIUS_MEDIA_URL` to the same origin as the Worker's `PUBLIC_URL`;
the CLI rejects completed upload links from a different origin.
The CLI's production media default is
`https://cli-media.spatius.ai`; configure its Worker custom domain before release.

From `packages/media-worker`:

```sh
pnpm exec wrangler r2 bucket create spatius-cli-media-staging
pnpm exec wrangler r2 bucket lifecycle add spatius-cli-media-staging temporary-inputs media/ --expire-days 2 --abort-multipart-days 1 --force
pnpm exec wrangler secret put SIGNING_KEYS --env staging
pnpm exec wrangler deploy --env staging --dry-run
pnpm exec wrangler deploy --env staging
```

Provide the JSON secret through the secure secret prompt, not a command-line
argument. Provision production with its separate `spatius-cli-media-production`
bucket and `--env production`. Configure a Worker custom domain matching
`PUBLIC_URL`; do not attach a public domain directly to the R2 bucket or enable
`r2.dev`. Run `pnpm --filter @spatius/media-worker typegen` after config changes.

For key rotation, add a new key to `SIGNING_KEYS`, change `SIGNING_KEY_ID`, and
retain older keys until all links signed with them expire. Removing an old key
early breaks submitted jobs that are still fetching inputs.

## Storage and cleanup

The Worker streams exact-size 8 MiB parts into R2. The final part may be smaller.
It persists admission, accepted parts, and a frozen completion manifest in the
owner's Durable Object. A final whole-file digest check precedes URL publication.
There is no overwrite or completed-file deletion endpoint.

DO alarms abort incomplete uploads after one hour and delete completed inputs
after 24 hours. Failed cleanup retains quota reservations and retries. Signed
URLs expire exactly on time even if physical deletion is delayed. R2 lifecycle
rules are a fallback, not the mechanism enforcing link expiry.

Observe controlled error codes, rejected admissions, authentication outages,
upload completion failures, and cleanup retries. Keep invocation URL logging
disabled to avoid capturing signed links. Do not log request bodies or headers.

## Staging smoke test

1. Run `pnpm check`, then deploy staging with configured host, private bucket,
   lifecycle rules, and signing secret.
2. Point `SPATIUS_MEDIA_URL` to staging and use a private test config directory.
   If Studio also uses staging hosts, set `SPATIUS_STUDIO_URL` for its API and
   `SPATIUS_STUDIO_WEB_URL` for its browser frontend separately. Log in through
   the CLI with a Studio account approved for both Open APIs.
3. Run setup twice and verify the app ID is reused. Inspect output for accidental
   credential exposure.
4. Submit a real portrait from disk, poll the avatar job, and retain its avatar ID.
   Verify Console can fetch the source within the Avatar API's shorter timeout.
5. Submit real speech and a background from disk, wait for completion, download
   the MP4, and check its audio/video playback.
6. Interrupt an upload and resume its original file. Interrupt a video submission
   and resume its operation ID; verify only one remote job exists.
7. Verify another Studio user cannot read/manage the upload ID, and unauthenticated
   upload-management calls fail. Public file reads require a valid signature.

CI uses mocks and local Cloudflare bindings. It does not start paid generation.
The full 500 MiB multipart case runs locally against R2 bindings in the Worker tests.

## Release

Run `pnpm check` and the staging smoke test before the first npm release. Build and
publish `packages/cli` from an OIDC-enabled release environment with
`npm publish --tag experimental`; the package requests npm provenance. Its prepack script
bundles the executable and copies the matching skills, notices, and guides. Keep
the git release tag and npm version aligned so agents can use a matching skill
version. Publishing and production deployment are explicit release actions.
