# Spatius CLI

Create avatars and render videos from a coding agent or terminal. The CLI handles
Studio login, app credentials, temporary uploads, polling, and MP4 downloads.

Requires Node.js 22+, a Spatius Studio account, and separately approved Avatar
and Video API access. Avatar creation uses your existing Avatar Creations balance.
The CLI is experimental.

## Get started

After the npm release:

```sh
npm install -g @spatius/cli@beta
spatius auth login
spatius setup
```

Approve login in your local browser.

## Use with coding agents

```sh
npx skills add spatius-ai/spatius-cli --skill spatius-shared spatius-avatar spatius-video
```

See the [workflow guide](docs/workflows.md) for input requirements and recovery,
and the [Spatius API documentation](https://docs.spatius.ai/api-reference/video-generation)
for service behavior. Repository development instructions are in
[CONTRIBUTING.md](CONTRIBUTING.md).
