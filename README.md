# Spatius CLI

> [!NOTE]
> This project is still in beta.

Manage Studio apps and API keys, browse public/custom avatars, and create avatars
and videos from a coding agent or terminal.

Requires Node.js 22+ and a Spatius Studio account. Avatar creation, detail/jobs,
and video workflows additionally require Avatar & Video API access.
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

## Update

```sh
spatius update
```

Updates the global CLI and runs `skills update` for the three Spatius skills,
without prompts. Stable installations follow npm `latest`; beta installations
consider both `beta` and newer stable releases. Use `spatius update --channel beta`
or `--channel latest` to select a channel. Updates never downgrade the CLI.

Skills follow their recorded sources and the scope selected by `skills update`.
Local bundled skills can be skipped, and GitHub skills may have a different
version. The result reports mismatches and partial completion instead of silently
reinstalling skills. No installed skills means only the CLI is updated.

Normal commands can include an `updateAvailable` notice with the update command.
Registry checks run in the background at most daily; a newly discovered release
usually appears on the next invocation. Set `SPATIUS_NO_UPDATE_NOTIFIER=1` to
disable notices and background checks.

See the [workflow guide](docs/workflows.md) for input requirements and recovery,
and the [Spatius API documentation](https://docs.spatius.ai/api-reference/video-generation)
for service behavior. Repository development instructions are in
[CONTRIBUTING.md](CONTRIBUTING.md).
