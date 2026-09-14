# Avatar and video workflows

## Interactive installation

Run `npx @spatius/cli@beta install` in a local terminal with Node.js 22+, npm,
and npx. The wizard defaults to installing the global CLI and all three
bundled skills, then offers Studio login and automatic app/key setup. Each
component can be skipped, including when rerunning after partial completion.

The global CLI is installed with npm at the exact version running the wizard.
The skills CLI reads that version's bundled skills and asks which agents,
scope (current project or global), and installation method to use. Run the
wizard from the intended project if choosing project scope. The skills CLI
prints its own results; returning from that step can also mean it was skipped
or cancelled. Its installed files do not depend on keeping the npx cache.

`install` uses human-readable output and requires interactive stdin/stdout
outside CI. `--json` is rejected. Help and `spatius schema install` work without
a terminal or Studio login. Scripts should use `npm install -g @spatius/cli@beta`,
`npx skills add spatius-ai/spatius-cli --skill spatius-shared spatius-avatar spatius-video`,
`spatius auth login`, and `spatius setup` separately.

If npm fails, completed steps remain installed. Resolve npm registry or
permission issues and rerun, skipping completed components. Use a user-owned
npm prefix/cache or Node version manager for permission errors. The wizard
does not invoke sudo or edit shell configuration. For PATH warnings, add the
reported bin directory or put it before the conflicting executable and reopen
the terminal; use the printed versioned npx commands in the meantime.

Ctrl+C exits 130 and stops local work without rolling back completed steps.
Studio failures retain the normal login and uncertain-creation recovery rules.
The installer never automatically retries app/key creation with
`--retry-uncertain`. Studio login/setup does not grant Avatar or Video API approval.

## Authentication and output

Run `spatius auth login`, approve in a browser on the same machine, then run
`spatius setup`. Login is required for credential setup and temporary uploads;
Open API enablement still requires administrator approval. The CLI does not
grant access or alter creation allowances. API-key-only CLI use is not supported.

The Studio API and browser approval page have separate origins. Environment
settings are optional for production; configure both origins explicitly when
using a development or staging Studio deployment.

| Environment variable     | Default                         | Purpose                                                                   |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------- |
| `SPATIUS_STUDIO_URL`     | `https://api.studio.spatius.ai` | Login/token, identity, app/key management, and public/custom avatar lists |
| `SPATIUS_STUDIO_WEB_URL` | `https://app.spatius.ai`        | Expected browser approval origin                                          |
| `SPATIUS_CONSOLE_URL`    | `https://console.spatius.ai`    | Avatar/Video Open APIs and frontend-style session-token issuance          |
| `SPATIUS_MEDIA_URL`      | `https://cli-media.spatius.ai`  | Temporary uploads and input links                                         |

The web origin must match the Studio backend's configured frontend URL.
Credential-bearing API requests reject redirects; the browser URL must match
the configured web origin and the exact authorization request path.

Except for the interactive `install` command, commands return `{ "schemaVersion": 1, "ok": true, "data": ... }` on stdout.
Errors use `ok: false` and `error.code/message/retryable/recovery` on stderr.
Progress is also written to stderr. Help and version are plain text.

| Exit code | Meaning                                              |
| --------- | ---------------------------------------------------- |
| 0         | Success                                              |
| 1         | Operation failed; inspect the structured error       |
| 2         | Invalid command arguments                            |
| 3         | Waiting reached its deadline; the job remains active |
| 130       | Interrupted locally; no remote job is cancelled      |

## Studio management and avatar discovery

App/key management and avatar listing use Studio login only; they need neither app setup nor Open API
enablement. They match the Studio frontend's `/v1/apps`, app `/api-keys`,
`/v2/console/public-avatars`, and `/v2/console/custom-avatars` routes.

```sh
spatius apps list
spatius apps create --name "My app"
spatius apps get app_example
spatius apps keys create --app-id app_example
spatius apps keys list --app-id app_example --page-size 20
spatius avatars list --type public --page-size 20
spatius avatars list --type custom --status success,generating --page-size 20
```

Substitute an actual app ID. App creation and key creation are separate and do
not change the CLI's selected credentials. Use `spatius setup --app-id <id>`
when you want to select an app for rendering; setup may create a key if none exists.
`apps list` continues returning a sanitized array across all pages. Key and
avatar lists return one page and `pagination.nextPageToken`; pass that token
with `--page-token`, keeping page size and filters unchanged.

API keys are hidden by default. Key create/list returns a full SHA-256 `keyId`
for selection. `--show-secrets` explicitly reveals raw keys on stdout for a
private destination; never copy the output into logs, commits, or chat.
`spatius apps keys delete <keyId> --app-id <id>` resolves the fingerprint
privately and deletes the key. `spatius apps delete <id>` deletes the app and
its keys. Both perform deletion directly and clear matching local credentials
before submission; use setup intentionally afterward if rendering is needed.

App/key creation saves `operationId` and resolved input before a single POST.
Use `apps create --resume <operation-id>` or `apps keys create --resume <operation-id>`
without new input to inspect the saved outcome. Accepted operations return the
saved result; key resume with `--show-secrets` retrieves the existing key by
fingerprint. An uncertain or rejected operation is never resubmitted. On
`STUDIO_CREATION_UNCERTAIN`, inspect app/key lists and reconcile before choosing
a new creation. Names are not unique. `setup --retry-uncertain` does not apply
to these operations. Journals contain key fingerprints, never raw keys.

**Listing behavior change:** `avatars list` now defaults to Studio's `custom`
collection instead of the Open API account list. It returns `type`, `avatars`,
pagination, and custom `counts` when available. Custom listings include pending
and failed applications; filters are `success`, `generating`, and `failure`.
Public listings use `--type public` and reject status filters. Public items use
`id`; successful custom items supply `avatarId` for rendering. A custom display
`id` or `applyId` can identify a pending application and must not be treated as
a renderable avatar ID. Listing does not grant render permission.
`avatars get`, avatar creation/jobs, and video commands continue using Open APIs.

## Generate a session token

```sh
spatius apps session-tokens create --app-id app_example
```

The command matches the Studio app detail page: it retrieves an existing key
with Studio login, then sends one `POST /v1/console/session-tokens` using
`X-Api-Key` at `SPATIUS_CONSOLE_URL`. It requests a 24-hour lifetime and an empty
`modelVersion`. No app setup is required and no new app/key is created.
By default it selects the first available key; use `--key-id <full-keyId>`
from `apps keys list` for explicit selection across pages.

The result contains the secret `sessionToken`, `expireAt` in Unix seconds,
`operationId`, `appId`, `keyId`, `consoleOrigin`, and `modelVersion`.
Generation intentionally returns the token without a separate reveal flag;
keep stdout private and pass it only to its intended consumer.
The API key is never included in the result, and neither secret is stored in
the saved operation record or progress output.

Unlike Studio app/key reads, issuance uses Console key authentication. The
frontend chooses Console by region; set `SPATIUS_CONSOLE_URL` to the intended
region before login and CLI use. Profiles are scoped by Studio and Console
origins, so changing region may require login again. Studio bearer credentials
are never sent to Console, and redirects are rejected.

There are no automatic retries or `--resume` for session tokens. An uncertain
request or lost stdout may have issued a token valid until the recorded
`expireAt`; the CLI cannot retrieve that token later. Generate another only
when a new issuance is intended. On `SESSION_TOKEN_FAILED`, verify the app key
and Console region/access before trying again.

## Create, poll, and download

This Bash example requires `jq`. Supply your own portrait and speech files.

```sh
set -euo pipefail
spatius auth login
spatius setup
AVATAR_CREATE=$(spatius avatars create --image ./portrait.png --name Presenter)
AVATAR_JOB_ID=$(printf '%s' "$AVATAR_CREATE" | jq -er '.data.jobId')
AVATAR_RESULT=$(spatius avatars jobs wait "$AVATAR_JOB_ID" --timeout 600)
AVATAR_ID=$(printf '%s' "$AVATAR_RESULT" | jq -er '.data.job.avatarId')
VIDEO_CREATE=$(spatius videos create --avatar-id "$AVATAR_ID" --audio ./speech.wav)
VIDEO_JOB_ID=$(printf '%s' "$VIDEO_CREATE" | jq -er '.data.jobId')
spatius videos wait "$VIDEO_JOB_ID" --timeout 600
spatius videos download "$VIDEO_JOB_ID" --output ./video.mp4
```

If waiting exits 3, run the same wait command again. Creation accepts `--wait`
as a convenience, but submitting and waiting separately makes job IDs easier
to retain. Every creation exposes an operation ID in its result or recovery
error; progress reports the ID before external preparation begins.

## Inputs and presentation

| Input           | Types                                                         | Maximum size |
| --------------- | ------------------------------------------------------------- | -----------: |
| Avatar portrait | JPEG, opaque PNG; shorter side ≥340 pixels and one clear face |        5 MiB |
| Audio           | WAV, MP3, M4A/MP4 audio, AAC, Ogg                             |      500 MiB |
| Background      | JPEG, PNG, WebP                                               |       50 MiB |

The CLI and upload Worker check basic file signatures and sizes. Avatar content,
PNG opacity, image dimensions, audio decoding, and audio duration remain validated
by the existing services. Raw PCM and octet-stream sources are unsupported.

Use local paths or public HTTP(S) URLs, including signed URLs. Caller-supplied
URLs are not fetched by the CLI; existing Console download protections apply.
They cannot contain embedded credentials or point to private networks.

| Video option                              | Default | Allowed values                                |
| ----------------------------------------- | ------- | --------------------------------------------- |
| `--width`, `--height`                     | 1024    | Even integers 64–1920; area ≤2,073,600 pixels |
| `--fit`                                   | crop    | crop, contain                                 |
| `--background-color`                      | #000000 | Six-digit RGB hex                             |
| `--background-fit`                        | cover   | cover, contain, stretch                       |
| `--lead-in-seconds`, `--lead-out-seconds` | 0       | Finite values 0–60                            |

Quote hex colors in shells. Encoding is service-controlled. Source URLs need to
cover the preparation window of up to 30 minutes. Temporary inputs are immutable
and expire 24 hours after upload completion. Anyone with a signed input URL can
read it until expiry; avoid sharing these URLs outside the intended workflow.

## Resume safely

| Situation                                 | Action                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interrupted upload                        | Re-run `assets upload <same-file> --kind <kind> --resume <upload-or-operation-id>`; accepted parts are reused. An aborted multipart needs a fresh upload. |
| Video preparation or uncertain submission | `videos create --resume <operation-id>` reuses the saved request UUID and exact URLs.                                                                     |
| Repeating a chosen video `--request-id`   | The same original input resumes its operation; different input conflicts before uploading.                                                                |
| Avatar submission response lost           | `SUBMISSION_UNCERTAIN`: inspect recent avatar jobs and reconcile. Automatic resubmission is unsafe because this API has no retry key.                     |
| Known job                                 | Poll/wait by job ID; do not submit again.                                                                                                                 |
| Terminal failure                          | Fix its cause and intentionally start a new operation if wanted. `retryable` does not restart a job.                                                      |
| Output link expired                       | `videos download` requests a fresh link, while output retention remains unchanged.                                                                        |

Downloads require direct HTTPS output links and use no Studio/app authentication
headers. Redirects are rejected with a retryable availability error; run download
again for a fresh link. Loopback HTTP is allowed only when the CLI Console origin
is explicitly configured for loopback development. Downloads stream into a temporary
file in the destination directory, then rename atomically. Existing files require
`--force`. Video output currently expires seven days after submission; use
`job.expiresAt` as authoritative. Expired output cannot be recovered by refreshing
a link.

## Account and storage limits

The existing APIs enforce user-level permissions, request rates, avatar concurrency,
and billing. The CLI does not add a video concurrency quota. All apps belonging
to one account share the server's Open API policies.

Temporary storage separately defaults to 2 GiB reserved/retained per user,
100 new uploads per rolling day, and 10 unfinished uploads. Management requests
are limited to 10/second with burst 20. Unfinished uploads expire after one hour.
Rejected requests return controlled errors; repeated upload admission with the
same retry UUID does not consume another reservation.

Credentials and saved input URLs are stored under private user configuration,
outside repositories. On macOS/Linux use `$XDG_CONFIG_HOME/spatius` or
`~/.config/spatius`; Windows uses `%APPDATA%/Spatius`. Set `SPATIUS_CONFIG_DIR`
to an absolute private directory to isolate test accounts. macOS/Linux are the
validated v1 platforms; Windows storage relies on inherited user-directory ACLs.

If the cached CLI app was deleted, `spatius setup` reconciles existing apps and
creates a replacement when needed. An explicit `--app-id` is never silently replaced.

Logout clears local tokens and cached API keys and attempts refresh revocation.
The current Studio backend does not immediately revoke already issued access
tokens. It also does not provide cross-machine app-creation deduplication:
simultaneous first-time setup may require selecting among matching apps.
