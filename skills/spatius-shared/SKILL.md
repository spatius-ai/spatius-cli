---
name: spatius-shared
description: Set up Spatius CLI authentication, manage Studio apps and API keys, generate session tokens, inspect command schemas, and recover account access for avatar or video workflows. Use when preparing Spatius CLI, managing app credentials or session tokens, or resolving authentication and setup errors.
license: MIT
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

App/key management uses Studio login and does not require `setup` or Open API
enablement. Read [Studio management](references/studio-management.md) for
creation, key selection, deletion, and uncertain-creation recovery. App creation
and key creation are separate commands; neither changes the CLI's selected app.

```sh
spatius apps list
spatius apps get app_example
spatius apps create --name "My app"
spatius apps keys list --app-id app_example
```

Replace `app_example` with an owned app ID. Key listings return a non-secret
`keyId` fingerprint by default. Keep raw keys out of chat and diagnostics;
use `--show-secrets` only when explicitly needed for private credential delivery.

For a frontend-style 24-hour session token, use
`spatius apps session-tokens create --app-id <id>`. This command intentionally
returns a secret `sessionToken` on stdout; send it only to the intended private
destination. It retrieves an existing key through Studio and generates the token
at the configured Console origin. Read [Studio management](references/studio-management.md)
for key selection, region configuration, and lost-response recovery.

Except for the human-only `install` command, success is one JSON object on stdout with `schemaVersion`, `ok`, and `data`.
Progress and structured failures go to stderr. Inspect the exit code and error
`code`, `retryable`, and `recovery`; avoid parsing decorative human text. Exit 3
means a wait deadline, and does not cancel the remote job.

Save returned operation and job IDs. After interrupted creation, use the saved
operation's resume command; after admission, poll its job. An error marked
retryable is not authorization to create another paid job indefinitely.

For ambiguous setup, rotating-token failures, or source-link privacy, read
[recovery](references/recovery.md). Do not use `setup --retry-uncertain` until the
uncertain creation has been reconciled and another creation is intended.
