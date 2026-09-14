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
release. `scripts/set-version.mjs <version>` stamps the CLI manifest and all three
skills' quoted `metadata.version` fields together, after validating every input.
Release preparation invokes it before dependencies are installed. Skill and
tarball checks require exact CLI/skill version equality.

Keep Worker `/v1` changes compatible with older CLI versions and uploads already
in progress. Publish one release at a time. The
[deployment guide](docs/deployment.md) covers one-time Cloudflare/npm setup,
release commands, and recovery after partial failure. `pnpm check` does not
publish packages, deploy services, or start paid generation.

## Installer development

The interactive `install` command loads its UI lazily. Keep process execution
and npm/skills mechanics separate from prompt orchestration; tests inject
services and auth instead of installing global packages or using live accounts.
The installer uses matching packaged skills, so test the installed tarball as
well as workspace execution. Its human-output exception is declared in command
schema metadata; existing commands retain their JSON contracts.

When changing terminal presentation, review in a PTY against create-spatius-app:
normal animation, narrow terminals, NO_COLOR, resize, handoff to skills, and
Ctrl+C. Use a local mock-service harness; never run live npm global installation
or Studio setup as a test side effect. Run `pnpm check` before handoff.

## Updater development

`spatius update` loads its services lazily without constructing Studio auth or
the installer UI. All updater dependencies load before replacing the global
package. Tests inject npm/skills runners and registry fetches; never update real
global packages or agent skills during tests. The upstream `skills update`
command owns scope, source, and overwrite behavior. Verification reports what
`skills list --json` discovers in project and global scope; no custom reinstall
or rollback is attempted.

The notifier reads a bounded local `update-check.json` and launches the packaged
`dist/update-check.js` helper only after command output. Registry IO happens
exclusively in that detached process with a five-second request deadline and
ten-second lifetime. A lock expires after 30 seconds; failed checks wait one
hour, successful checks 24 hours. Cache failures are silent. Tests and artifact
checks disable the notifier unless explicitly testing it, and compare warm-cache
startup with the baseline rather than making network speed a test prerequisite.

## Completion development

Keep command discovery and completion resolution in `packages/cli/src/commands.ts`.
Shell adapters live in `packages/cli/src/completions.ts`; they pass partial argv
after `__complete --` and treat replies as literal data. They must never evaluate
reply text or initialize authentication, configuration, or network clients.
Add file hints and allowed values to command definitions, so parser, schema,
and completions remain aligned. The public `completion` command declares its
raw script output exception in the schema.

Install Bash, Zsh, and Fish to exercise all adapter tests locally. Missing shells
are skipped locally and required in CI. Tests use an isolated executable and
temporary media paths; no shell profiles or login state are changed. Verify
the installed tarball as well as source execution with `pnpm check`.

Installer completion persistence lives in `packages/cli/src/install/completions.ts`.
Keep shell detection bounded, inspect process identity rather than arguments,
and account for npm exec/npx wrappers and transient PATH entries. Test profile
updates in temporary home directories, including symlinks, login-file priority,
XDG/ZDOTDIR overrides, backups, repeat installation, and cancellation. Review
the shell-selection prompt in a PTY with mocked package and Studio services;
never install globally or edit your real shell profiles as a test.
