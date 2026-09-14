# Deployment and releases

A published GitHub release deploys the production media Worker, then publishes
`@spatius/cli` with its matching skills and documentation. The executable remains
`spatius`. Keep the repository private while preparing this setup; perform the
first publication after it becomes public.

## Release contract

| Setting     | Behavior                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Trigger     | GitHub `release.published`, including prereleases; pushing a tag alone does not publish           |
| Source      | Exact release commit, reachable from `main`; public repository required for provenance            |
| Version     | Canonical `vX.Y.Z[-prerelease]` tag without build metadata; GitHub prerelease checkbox must agree |
| npm channel | Any prerelease → `beta`; stable → `latest`                                                        |
| Worker      | `spatius-cli-media` at `https://cli-media.spatius.ai` for **every** release                       |
| Runtime     | GitHub-hosted Ubuntu, Node 24, compatible npm, and the workspace's pinned pnpm/Wrangler           |

The workflow validates the release and npm version, runs `pnpm check`, installs
and tests the exact release tarball, deploys the Worker, checks HTTPS health and
unauthenticated upload rejection, and publishes that tarball with provenance.
Only a registry 404 permits a new version; duplicates and registry errors stop
before deployment. The release version is written in the runner only. There is
no version commit and no new tag created by CI.

Worker deployments record the release tag and commit SHA. Actions summarizes the
Worker deployment and npm publication. Keep Worker `/v1` compatible with older
CLI versions and inputs still in use. Prereleases also update production.

## One-time production setup

### 1. Cloudflare account, bucket, and domain

Use the Spatius Cloudflare account `5e47c9255b3c952c52f162ed53f6e14a`, with Workers
Paid and R2 enabled, and the active `spatius.ai` zone. In the dashboard, verify
that `cli-media.spatius.ai` is unused or already belongs to this Worker. Wrangler
can replace an existing custom-domain origin during noninteractive deployment.

Install dependencies from the repository root, then use the operator's Wrangler
login to provision storage:

```sh
pnpm install --frozen-lockfile
export CLOUDFLARE_ACCOUNT_ID=5e47c9255b3c952c52f162ed53f6e14a
cd packages/media-worker
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler r2 bucket create spatius-cli-media-production
pnpm exec wrangler r2 bucket lifecycle add spatius-cli-media-production temporary-inputs media/ --expire-days 2 --abort-multipart-days 1 --force
pnpm exec wrangler r2 bucket lifecycle list spatius-cli-media-production
```

Keep the R2 bucket private: no bucket custom domain and no `r2.dev` access. The
production Worker configuration attaches `cli-media.spatius.ai` to the Worker
and disables its `workers.dev` endpoint. Provisioning storage needs the
operator's R2 permissions; routine release credentials do not create buckets.
If the bucket or lifecycle rule already exists, inspect and retain it instead
of repeating creation; lifecycle additions append rules.

### 2. Signing secret and first Worker deployment

From `packages/media-worker`, generate the production key once and pipe it
directly into Wrangler. The JSON contains a `v1` key matching `SIGNING_KEY_ID`:

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(JSON.stringify({ v1: randomBytes(32).toString("hex") }));' \
  | pnpm exec wrangler secret put SIGNING_KEYS --env production
pnpm exec wrangler secret list --env production
pnpm exec wrangler deploy --env production --dry-run
pnpm exec wrangler deploy --env production
curl --fail --silent --show-error --max-time 15 https://cli-media.spatius.ai/health
```

Wrangler may offer to create the Worker when storing its first secret. The first
full deployment applies its Durable Object migration and custom domain. Preserve
the Worker name, bucket, Durable Object binding, and migration history across
releases. `SIGNING_KEYS` is required; recurring deployments retain the saved
secret. Do not regenerate it when retrying deployment.

Before npm publication, run the authenticated upload/read check below. `/health`
checks process/routing only; it does not prove Studio auth, storage, or signing.
No Console signing secret, renderer token, app API key, or Studio refresh token
belongs in this Worker.

### 3. GitHub configuration

In `spatius-ai/spatius-cli`, configure:

| Setting                 | Type                        | Value/access                                                                          |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Actions repository secret   | **Workers Scripts: Edit** for the production account; **Zone: Read** for `spatius.ai` |
| `CLOUDFLARE_ACCOUNT_ID` | Actions repository variable | `5e47c9255b3c952c52f162ed53f6e14a`                                                    |

For example, the GitHub CLI prompts securely for the API token:

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo spatius-ai/spatius-cli
gh variable set CLOUDFLARE_ACCOUNT_ID --repo spatius-ai/spatius-cli --body 5e47c9255b3c952c52f162ed53f6e14a
```

Only the deployment job receives Cloudflare credentials. Only the npm job gets
`id-token: write`; all jobs have `contents: read`. Leave `SIGNING_KEYS` in
Cloudflare. Do not configure `NPM_TOKEN`, Studio credentials, or renderer
credentials in GitHub. No approval environment or release enablement variable
is required.

### 4. Create the npm package

After the repository is public and production upload/read validation passes,
use an npm account with 2FA and permission to publish under `@spatius`.
The package must exist before configuring its trusted publisher, so create
`0.1.0-beta.0` once from the checked tarball. This initial manual publication has
no provenance; automated releases have provenance.
[npm trusted-publisher prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites)

From a clean repository root containing the merged release changes:

```sh
pnpm install --frozen-lockfile
pnpm check
SPATIUS_RELEASE_DIR=$(mktemp -d)
pnpm package:check -- --artifact-dir "$SPATIUS_RELEASE_DIR"
npm login --registry=https://registry.npmjs.org
npm publish "$SPATIUS_RELEASE_DIR/spatius-cli-0.1.0-beta.0.tgz" --access public --tag beta --provenance=false --ignore-scripts
```

`package:check` retains the validated tarball and `release-artifact.json`
(name, version, filename, and integrity) in the requested directory. Publish that
same tarball instead of rebuilding after validation. This bootstrap does not
need a published GitHub release; publishing `v0.1.0-beta.0` afterward would fail
the duplicate-version check. If the package already exists, inspect its versions
and configure the publisher instead of repeating bootstrap.

### 5. Configure npm trusted publishing

In the npm settings for `@spatius/cli`, add this trusted publisher:

| Field             | Value                           |
| ----------------- | ------------------------------- |
| Provider          | GitHub Actions                  |
| Organization      | `spatius-ai`                    |
| Repository        | `spatius-cli`                   |
| Workflow filename | `publish.yml`                   |
| Environment       | Leave blank                     |
| Allowed action    | Enable direct **`npm publish`** |

New publishers may default to staged publication; select direct publication so
GitHub releases complete automatically. npm uses the job's OIDC identity without
a long-lived token. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

### 6. Publish releases

After merge and CI pass, select a commit on `main` and publish the first automated
release as `v0.1.0-beta.1`, with the GitHub prerelease checkbox selected. For
example, from the clean repository root:

```sh
git fetch origin main
SPATIUS_RELEASE_COMMIT=$(git rev-parse origin/main)
gh release create v0.1.0-beta.1 --repo spatius-ai/spatius-cli --target "$SPATIUS_RELEASE_COMMIT" --prerelease --generate-notes
```

Wait for its Actions run, then verify:

```sh
npm install -g @spatius/cli@beta
spatius --version
spatius --help
```

Stable releases use a tag such as `v0.1.0`, with the prerelease checkbox cleared,
and install with `npm install -g @spatius/cli` (`latest`). No release proceeds
while the repository is private. Ordinary pushes and pull requests run checks
without deployment or publication.

## Partial failure and retry

Publish one release at a time. A shared concurrency group with `queue: max`
keeps pending releases without cancelling a running release. Do not rely on the
queue to order releases for you.

| Failure                                       | Recovery                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Release validation, registry lookup, or tests | Fix the cause; Worker and npm remain unchanged                                                                 |
| Worker deployment or post-deployment checks   | npm is not published; inspect the actual Worker deployment before retrying                                     |
| npm publication after Worker deployment       | Keep the compatible Worker running; inspect npm before retrying. No automatic rollback or publish retry occurs |
| Version already exists in npm                 | Confirm its integrity/version and the Actions result; do not overwrite or republish it                         |
| Newer release has deployed since a failure    | Fix forward with a new version; never rerun the older release and roll production backward                     |

Before rerunning a failed release, check its exact version with
`npm view @spatius/cli@<version> version dist.integrity --json`, and check the
Worker's release tag/commit in Cloudflare or `wrangler versions list --env production`.
For an npm-only failure, rerun all jobs only after confirming the version is
absent and no newer release has deployed. This repeats validation and deployment
before publication. A network error from npm is not evidence that the version is
absent.

## Configuration and storage

| Setting                                | Purpose                                                         |
| -------------------------------------- | --------------------------------------------------------------- |
| `STUDIO_API_URL`                       | Trusted Studio origin for online `GET /v1/auth/me` validation   |
| `PUBLIC_URL`                           | Actual Worker HTTPS origin used to sign immutable input URLs    |
| `SIGNING_KEY_ID`                       | Active key ID for new links                                     |
| `SIGNING_KEYS` (secret)                | JSON map of key IDs to random secrets of at least 32 characters |
| `MAX_STORED_BYTES`                     | Per-user reserved/retained byte limit; default 2 GiB            |
| `MAX_UPLOADS_PER_DAY`                  | New uploads per rolling day; default 100                        |
| `MAX_UNFINISHED_UPLOADS`               | Unfinished uploads per user; default 10                         |
| `REQUESTS_PER_SECOND`, `REQUEST_BURST` | Management-operation token bucket; default 10 and 20            |

The Worker streams exact-size 8 MiB parts to private R2, with a smaller final
part allowed. Each Studio user's SQLite Durable Object persists admission,
accepted parts, and the completion manifest. The whole-file digest is checked
before its URL is published. Completed files cannot be overwritten or deleted
through a public endpoint.

DO alarms abort incomplete uploads after one hour and delete completed inputs
after 24 hours. Failed cleanup retains quota reservations and retries. Signed
URLs expire on time even if physical deletion is delayed. R2 lifecycle rules
are fallback cleanup. For key rotation, add a key to `SIGNING_KEYS`, change
`SIGNING_KEY_ID`, and retain old keys until every link signed with them expires.

Monitor rejected admissions, authentication outages, upload completion failures,
and cleanup retries through controlled error codes. Keep invocation URL logging
disabled; request bodies, auth headers, and signed URLs must not enter logs.
Run `pnpm --filter @spatius/media-worker typegen` after configuration changes.

## Live smoke tests

Routine CI uses mocks/local bindings and performs no paid generation. Live tests
need the intended user's Studio login and approved Avatar/Video API access.
From an unpublished checkout, run `pnpm package:check`, then use
`node packages/cli/dist/cli.js` in place of `spatius` in these examples.

**Upload/read check:** supply a real `./speech.wav`, a private config directory,
and the intended media origin. This example needs Node.js. The signed URL stays
in the pipeline rather than being printed:

```sh
export SPATIUS_CONFIG_DIR=/absolute/path/to/private-test-config
export SPATIUS_MEDIA_URL=https://cli-media.spatius.ai
spatius auth login
spatius setup
spatius assets upload ./speech.wav --kind audio | node --input-type=module -e '
import { createHash } from "node:crypto";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { data } = JSON.parse(input);
if (data.status !== "completed") throw new Error("Upload not completed");
const response = await fetch(data.url, { redirect: "error", signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error("Signed file read failed");
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length !== data.size || createHash("sha256").update(bytes).digest("hex") !== data.sha256) throw new Error("File mismatch");
console.log("Authenticated upload and signed read passed");'
```

Repeat setup and confirm the app ID is reused. Verify unsigned file reads and
unauthenticated upload-management calls fail, and that a second Studio user
cannot read/manage the first user's upload ID. The automated release probes
check only health and unauthenticated rejection, not this authenticated flow.

**Avatar → video → MP4:** follow the complete create/poll/download example in
[workflows](workflows.md) using a real portrait, speech, and optional background.
Save operation/job IDs, check progress, download the MP4 before expiry, and
verify audio/video playback. Avatar creation and video generation use existing
service allowances/accounting. Interrupted submissions should resume the saved
operation; confirm only one remote job exists. Keep private inputs, IDs, and
signed URLs out of public CI logs.

**Staging:** use the separate `spatius-cli-media-staging` Worker and bucket,
`--env staging`, and set `SPATIUS_MEDIA_URL` to
`https://spatius-cli-media-staging.472617147.workers.dev`. Provision the same
lifecycle rule on that bucket and its own signing key. If Studio uses staging
hosts, set API `SPATIUS_STUDIO_URL` and browser `SPATIUS_STUDIO_WEB_URL`
separately. The CLI requires completed upload links to match its configured
media origin. The existing [staging validation record](staging-validation.md)
is evidence for staging, not production readiness.
