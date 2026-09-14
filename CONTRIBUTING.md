# Development

Install Node.js 22+ and pnpm 12.3.4, then run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @spatius/cli dev schema
```

The workspace contains the npm CLI, a Cloudflare media Worker, and upload/media
contracts shared by both. Node tests use Vitest; Worker tests run against local
R2 and SQLite Durable Object bindings. No paid rendering jobs run in CI.

```sh
pnpm --filter @spatius/cli test
pnpm --filter @spatius/media-worker test
pnpm --filter @spatius/media-worker typegen
pnpm format
```

`pnpm package:check` installs the npm tarball in an isolated directory and verifies
the `spatius` executable, its version, and matching skills and documentation.
To retain that exact checked artifact for publication, run
`pnpm package:check -- --artifact-dir /absolute/path/to/release-artifacts`.
Skill validation checks frontmatter, reference reachability, and example commands against the actual parser. A release must not publish a CLI
version that disagrees with its packaged skills.

For local integration, explicitly configure origins and use an isolated config
directory. HTTPS is required for remote origins; HTTP is allowed only on loopback.

```sh
export SPATIUS_STUDIO_URL=http://127.0.0.1:8083
export SPATIUS_STUDIO_WEB_URL=http://127.0.0.1:3000
export SPATIUS_CONSOLE_URL=http://127.0.0.1:8083
export SPATIUS_MEDIA_URL=http://127.0.0.1:8787
export SPATIUS_CONFIG_DIR=/absolute/path/to/private-test-config
```

The Studio web origin must match the backend's `SERVER_OPEN_PLATFORM_FRONTEND_URL`;
authentication/app requests use the Studio API origin, while the browser approval
page uses the web origin.

No `.env` file is loaded implicitly by the CLI. Never commit that configuration
directory. See [deployment](docs/deployment.md) for Worker setup and live validation.

## Releases

Publishing a GitHub release runs checks, deploys the production media Worker, and
publishes `@spatius/cli`. Tags provide the version: `v0.1.0-beta.1` goes to npm
`beta`; `v0.1.0` goes to `latest`. Both deploy `https://cli-media.spatius.ai`.
The release commit must be on `main`, and the repository must be public. Version
changes occur only in the release runner; do not commit a version bump for each
release.

Keep Worker `/v1` changes compatible with older CLI versions and uploads already
in progress. Publish one release at a time. The
[deployment guide](docs/deployment.md) covers one-time Cloudflare/npm setup,
release commands, and recovery after partial failure. `pnpm check` does not
publish packages, deploy services, or start paid generation.
