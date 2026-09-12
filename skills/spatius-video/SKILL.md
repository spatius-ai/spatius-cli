---
name: spatius-video
description: Render downloadable Spatius avatar videos from audio and optional backgrounds using Spatius CLI. Use for local or URL media preparation, video submission, polling, safe resume, and MP4 download.
license: MIT
---

# Render an avatar video

Use an existing permitted avatar ID, or create one with the avatar skill. Check
`spatius auth status` and `spatius schema videos create` before the workflow.
Studio login and Video API approval are separate requirements.

Use the supplied audio and optional background; the CLI does not synthesize
speech. Local files upload automatically. Supported audio includes WAV, MP3,
M4A/MP4 audio, AAC, and Ogg, up to 500 MiB. Backgrounds are JPEG, PNG, or WebP up
to 50 MiB. Raw PCM must first be wrapped correctly in WAV; changing its extension
does not convert it. For settings and lifetime details, read
[inputs and recovery](references/inputs-and-recovery.md).

```sh
spatius videos create --avatar-id 00000000-0000-4000-8000-000000000001 --audio ./speech.wav --background ./background.png --dry-run
spatius videos create --avatar-id 00000000-0000-4000-8000-000000000001 --audio ./speech.wav --background ./background.png
```

Replace the UUID and paths with the actual inputs. Save `operationId` and
`jobId`. The CLI saves a request UUID and resolved URLs before submission.
After interruption, use `spatius videos create --resume <operation-id>`;
do not rerun creation with fresh uploads or a new request UUID.

```sh
spatius videos wait 00000000-0000-4000-8000-000000000001 --timeout 600
spatius videos download 00000000-0000-4000-8000-000000000001 --output ./video.mp4
```

Replace the example job UUID with the returned one. Waiting polls every 15 seconds;
exit 3 means the job is still pending. Download obtains a fresh link and writes
the MP4 atomically. It refuses to replace an existing file unless `--force` is
explicitly supplied.

If a successful job's download-link refresh fails, retry the read/download.
A terminal `failed` or `expired` job does not restart. Explain its error and only
create another render when that is the intended next action. A saved operation
whose source URLs expired after an uncertain submission needs reconciliation,
not replacement inputs under the old request ID.
