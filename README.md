# Spatius CLI

> [!NOTE]
> This project is still in beta.

Create avatars and render videos from a coding agent or terminal.

Requires Node.js 22+, a Spatius Studio account, and Avatar & Video API access.
Avatar creation uses your existing Avatar Creations balance.

## Install

```sh
npx @spatius/cli install
```

### Manual installation

```sh
npm install -g @spatius/cli
spatius auth login
spatius setup
```

#### Use with coding agents

```sh
npx skills add spatius-ai/spatius-cli --skill spatius-shared spatius-avatar spatius-video
```

See the [workflow guide](docs/workflows.md) for input requirements and recovery,
and the [Spatius API documentation](https://docs.spatius.ai/api-reference/video-generation)
for service behavior. Repository development instructions are in
[CONTRIBUTING.md](CONTRIBUTING.md).
