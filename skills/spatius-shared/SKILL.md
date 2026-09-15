---
name: spatius-shared
description: Set up Spatius CLI authentication and app credentials, inspect command schemas, and recover account access for avatar or video workflows. Use when preparing Spatius CLI or resolving its authentication and setup errors.
license: MIT
metadata:
  version: '0.1.0-beta.0'
---

# Spatius setup and shared behavior

Use the installed `spatius` executable. If installation is needed, the prerelease
package is `@spatius/cli@beta` (`npm install -g @spatius/cli@beta`); stable releases
use `@spatius/cli`. The executable name remains `spatius`.
For human onboarding, `npx @spatius/cli@beta install` opens an interactive
installer for the global CLI, all three bundled skills, and optional Studio
login/setup. It requires a local terminal outside CI and does not support
`--json`. Agent scripts should use the individual commands below; do not run
the installer expecting structured output or unattended prompts. The skills
installer owns agent and scope selection. A completed handoff is not proof
that skills were installed; check its results.

Read `spatius --version` and `spatius schema` to discover the installed contract.
The CLI requires Node.js 22+. The npm package includes matching skills under
`skills/`; prefer those over default-branch skills when versions differ.

Each skill's `metadata.version` identifies its matching CLI release. To update
an existing installation without prompts, use:

```sh
spatius update
spatius update --channel beta
```

The command updates the global CLI, then runs `skills update` for the three
Spatius skills. The default follows the installed release track and never
downgrades. Skills retain upstream source/scope behavior: local bundles may be
skipped and GitHub sources may differ from npm. Inspect per-skill version status;
`UPDATE_SKILLS_INCOMPLETE` retains the CLI update and requires resolving the
skill mismatch. An absent skill is reported without installing it. Do not
interpret a successful skills subprocess as proof that versions match.

```sh
spatius auth status
spatius auth login
spatius setup
```

The production browser approval origin is `https://app.spatius.ai`; the Studio
API is `https://api.studio.spatius.ai`. For an explicitly configured development
environment, `SPATIUS_STUDIO_WEB_URL` selects the approved browser origin and
`SPATIUS_STUDIO_URL` selects the API. Do not change these to bypass an
`UNSAFE_AUTH_URL` error; check the intended environment first.

Run login only when needed. It opens a local browser approval page and waits up
to five minutes. Hand the approval URL to the user; keep the process alive until
approval or timeout. The browser must reach the CLI's localhost callback. A
remote agent without that connection needs the user to run login on the machine
where subsequent CLI commands run. Do not request tokens or passwords in chat.

Setup reuses an owned `Spatius CLI` app and key. If selection is required, use
`spatius apps list` and `spatius setup --app-id <id>`. Never read credential files
to obtain keys. Login does not grant Avatar or Video API approval; report a 403
as an account/permission issue instead of repeatedly logging in.

Except for the human-only `install` command, success is one JSON object on stdout with `schemaVersion`, `ok`, and `data`.
Progress and structured failures go to stderr. Inspect the exit code and error
`code`, `retryable`, and `recovery`; avoid parsing decorative human text. Exit 3
means a wait deadline, and does not cancel the remote job.

Success and error envelopes may include optional top-level `updateAvailable`
metadata with `currentVersion`, `latestVersion`, `message`, and `command`.
Surface that notice to the user without treating it as a workflow failure or
restarting an operation. Run its `spatius update` command when updating is
requested. Registry checks happen in the background; cached notices normally
appear on a later invocation. `SPATIUS_NO_UPDATE_NOTIFIER=1` disables checks and
notices. Install, update, and dry-run commands do not start automatic checks;
help/version output can show a cached notice on stderr.

Save returned operation and job IDs. After interrupted creation, use the saved
operation's resume command; after admission, poll its job. An error marked
retryable is not authorization to create another paid job indefinitely.

For ambiguous setup, rotating-token failures, or source-link privacy, read
[recovery](references/recovery.md). Do not use `setup --retry-uncertain` until the
uncertain creation has been reconciled and another creation is intended.
