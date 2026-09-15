# Recovery and credential boundaries

| Condition                           | Next action                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No login or `AUTH_RELOGIN_REQUIRED` | Have the user approve `spatius auth login` locally. A lost refresh response cannot safely reuse the old rotating token.                                                             |
| `UNSAFE_AUTH_URL`                   | Verify `SPATIUS_STUDIO_WEB_URL` matches the intended Studio frontend; `SPATIUS_STUDIO_URL` is the separate API origin. Do not approve an unexpected host.                           |
| App selection required              | Choose an owned app from sanitized candidates and run `spatius setup --app-id <id>`.                                                                                                |
| `BOOTSTRAP_UNCERTAIN`               | Run setup again to reconcile through reads. If unresolved, explain that the prior app/key creation may have succeeded; only use `--retry-uncertain` when a new attempt is intended. |
| HTTP 402                            | Ask the user to check the Avatar Creations balance in Studio.                                                                                                                       |
| HTTP 403                            | Check API enablement or avatar permission with the administrator. Login does not change the allowlist.                                                                              |
| HTTP 429                            | Respect the retry hint. Stop after bounded retries and report the limiting condition.                                                                                               |

If a cached app was deleted, run `spatius setup` to select or create its replacement.
If an explicitly supplied `--app-id` is unavailable, choose an owned app instead;
the CLI does not silently replace an explicit selection.

For `STUDIO_CREATION_UNCERTAIN` or `STUDIO_CREATION_REJECTED` from `apps create`
or `apps keys create`, follow [Studio management recovery](studio-management.md).
These saved operations use their own `--resume`; `setup --retry-uncertain` does
not reconcile them. A deleted selected app/key requires intentional setup before
rendering again. Studio management and avatar listing need only Studio login.

For `SESSION_TOKEN_FAILED` from `apps session-tokens create`, check the Console
region and selected app key. An uncertain issuance may have succeeded; retain
the operation ID and `expireAt`, and generate again only intentionally. Session
tokens are not saved and cannot be recovered or resumed. See
[session-token guidance](studio-management.md#session-tokens).

Do not echo credentials, refresh tokens, or credential-file contents. Download
URLs and temporary input URLs are bearer links: anyone possessing them can read
the file until expiry. Use them only for the intended workflow; avoid putting
them in commits, issue bodies, or diagnostics.

Logout clears local credentials and attempts refresh-token revocation. The
existing Studio backend does not immediately invalidate already issued access
tokens. Never claim that logout has remotely revoked every credential.

## Interactive installation

`npx @spatius/cli@beta install` is for a user in a local terminal. For
`INTERACTIVE_REQUIRED` or an `install --json` rejection, use the separate npm,
skills, authentication, and setup commands rather than retrying prompts in CI.

Completed steps survive installer failure or cancellation. Rerun the installer
and skip completed components. A skills subprocess can exit zero after the
user cancels: its own results are authoritative. Bundled skills match the
installer version; rerun that version to reinstall or update them together.

For npm permission errors, use a user-owned prefix/cache or a Node version
manager. Do not automatically elevate privileges or modify shell startup files.
For PATH warnings, follow the reported bin-directory and executable paths,
then reopen the terminal. Until resolved, use `npx @spatius/cli@<version>`
in place of `spatius`.

Studio login and setup errors retain their existing recovery rules above.
The installer never opts into `--retry-uncertain`.

## Non-interactive updates

`spatius update` works without a TTY and does not run Studio login or setup.
Its structured failure includes the completed CLI result, stage, and discovered
skill statuses. Completed steps remain installed; rerunning also retries the
skills step when the CLI is already current.

For `UPDATE_SKILLS_INCOMPLETE`, inspect `npx skills list --json` and
`npx skills list --global --json`, then compare each Spatius skill's
`metadata.version` with `spatius --version`. `skills update` follows recorded
sources and refs and may skip local bundles; it cannot guarantee an npm version
match. Resolve the source/version mismatch manually or use the interactive
installer from the desired CLI version to install its matching bundled skills.
The updater does not reinstall, back up, or roll back skills itself.

For registry or npm permission failures, fix connectivity or the user-owned npm
prefix/cache and rerun `spatius update`. For missing or invalid bundled metadata,
repair the global package from a release whose tarball passed validation. Keep
PATH warnings visible: the verified global binary may be shadowed by another
installation. Update notices do not change command success, errors, or job state.
