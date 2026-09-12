# Avatar and video workflows

## Authentication and output

Run `spatius auth login`, approve in a browser on the same machine, then run
`spatius setup`. Login is required for credential setup and temporary uploads;
Open API enablement still requires administrator approval. The CLI does not
grant access or alter creation allowances. API-key-only CLI use is not supported.

The Studio API and browser approval page have separate origins. Environment
settings are optional for production; configure both origins explicitly when
using a development or staging Studio deployment.

| Environment variable     | Default                         | Purpose                                         |
| ------------------------ | ------------------------------- | ----------------------------------------------- |
| `SPATIUS_STUDIO_URL`     | `https://api.studio.spatius.ai` | Login/token, identity, and app/key API requests |
| `SPATIUS_STUDIO_WEB_URL` | `https://app.spatius.ai`        | Expected browser approval origin                |
| `SPATIUS_CONSOLE_URL`    | `https://console.spatius.ai`    | Avatar and Video Open APIs                      |
| `SPATIUS_MEDIA_URL`      | `https://cli-media.spatius.ai`  | Temporary uploads and input links               |

The web origin must match the Studio backend's configured frontend URL.
Credential-bearing API requests reject redirects; the browser URL must match
the configured web origin and the exact authorization request path.

Commands return `{ "schemaVersion": 1, "ok": true, "data": ... }` on stdout.
Errors use `ok: false` and `error.code/message/retryable/recovery` on stderr.
Progress is also written to stderr. Help and version are plain text.

| Exit code | Meaning                                              |
| --------- | ---------------------------------------------------- |
| 0         | Success                                              |
| 1         | Operation failed; inspect the structured error       |
| 2         | Invalid command arguments                            |
| 3         | Waiting reached its deadline; the job remains active |
| 130       | Interrupted locally; no remote job is cancelled      |

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
