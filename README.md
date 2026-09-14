# Spatius CLI

> [!NOTE]
> This project is still in beta.

Create avatars and render videos from a coding agent or terminal. The CLI handles
Studio login, app credentials, temporary uploads, polling, and MP4 downloads.

Requires Node.js 22+, a Spatius Studio account, and separately approved Avatar
and Video API access. Avatar creation uses your existing Avatar Creations balance.
The CLI is experimental.

## Get started

```sh
npx @spatius/cli@beta install
```

Follow the terminal prompts to install the CLI and agent skills, then optionally
log in and set up Spatius Studio. Approve login in your local browser. You can
skip completed steps when rerunning the installer.

For manual installation or scripts:

```sh
npm install -g @spatius/cli@beta
spatius auth login
spatius setup
```

## Use with coding agents

```sh
npx skills add spatius-ai/spatius-cli --skill spatius-shared spatius-avatar spatius-video
```

See the [workflow guide](docs/workflows.md) for input requirements and recovery,
and the [Spatius API documentation](https://docs.spatius.ai/api-reference/video-generation)
for service behavior. Repository development instructions are in
[CONTRIBUTING.md](CONTRIBUTING.md).
