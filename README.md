# Spatius CLI

Create avatars and render videos from a coding agent or terminal. The CLI handles
Studio login, app credentials, temporary uploads, polling, and MP4 downloads.

Requires Node.js 22+, a Spatius Studio account, and separately approved Avatar
and Video API access. Avatar creation uses your existing Avatar Creations balance.
The CLI is experimental.

## Get started

After the npm release:

```sh
npm install -g spatius-cli
spatius auth login
spatius setup
```

Approve login at `https://app.spatius.ai` in your local browser. Studio API
requests use `https://api.studio.spatius.ai`; development origin settings are
documented in the [workflow guide](docs/workflows.md). Credentials stay in private user configuration
storage; commands never print API keys. Setup reuses a dedicated `Spatius CLI` app.
Use `spatius setup --app-id <id>` to select another app you own.

```sh
spatius avatars create --image ./portrait.png --name Presenter
spatius avatars jobs wait <avatar-job-id>
spatius videos create --avatar-id <avatar-id> --audio ./speech.wav --background ./background.png
spatius videos wait <video-job-id>
spatius videos download <video-job-id> --output ./video.mp4
```

Inputs accept local files or public HTTP(S) URLs. Local files are uploaded to
temporary storage and remain available for 24 hours after upload completion.
Video output follows the service's retention deadline, currently seven days
after render submission. Save your MP4 before it expires.

Commands return JSON on stdout; progress and errors go to stderr. Save the
`operationId` and `jobId` returned by creation. Resume an interrupted creation with
`spatius videos create --resume <operation-id>` or
`spatius avatars create --resume <operation-id>`; do not start a fresh creation
just because a command timed out.

## Use with coding agents

```sh
npx skills add spatius-ai/spatius-cli --skill spatius-shared spatius-avatar spatius-video
spatius schema
spatius schema videos create
```

The three skills cover setup, avatar creation, and video generation. Skills and
CLI behavior ship together. `--dry-run` previews a creation without uploading or
submitting it. `--help` describes the installed CLI's options.

See the [workflow guide](docs/workflows.md) for input requirements and recovery,
and the [Spatius API documentation](https://docs.spatius.ai/api-reference/video-generation)
for service behavior. Repository development instructions are in
[CONTRIBUTING.md](CONTRIBUTING.md).
