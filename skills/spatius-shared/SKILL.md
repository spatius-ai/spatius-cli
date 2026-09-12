---
name: spatius-shared
description: Set up Spatius CLI authentication and app credentials, inspect command schemas, and recover account access for avatar or video workflows. Use when preparing Spatius CLI or resolving its authentication and setup errors.
license: MIT
---

# Spatius setup and shared behavior

Use the installed `spatius` executable, or the published `spatius-cli` npm package.
Read `spatius --version` and `spatius schema` to discover the installed contract.
The CLI requires Node.js 22+. Skills and CLI versions should match.

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

Success is one JSON object on stdout with `schemaVersion`, `ok`, and `data`.
Progress and structured failures go to stderr. Inspect the exit code and error
`code`, `retryable`, and `recovery`; avoid parsing decorative human text. Exit 3
means a wait deadline, and does not cancel the remote job.

Save returned operation and job IDs. After interrupted creation, use the saved
operation's resume command; after admission, poll its job. An error marked
retryable is not authorization to create another paid job indefinitely.

For ambiguous setup, rotating-token failures, or source-link privacy, read
[recovery](references/recovery.md). Do not use `setup --retry-uncertain` until the
uncertain creation has been reconciled and another creation is intended.
