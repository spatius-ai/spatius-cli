# Studio apps and keys

App and key management use the Studio bearer login at `SPATIUS_STUDIO_URL`.
Session-token issuance additionally uses an app key at the Console origin,
matching the Studio frontend. Inspect `spatius schema apps create`
and `spatius schema apps keys list` for the installed contract.

```sh
spatius apps list
spatius apps create --name "My app"
spatius apps get app_example
spatius apps keys create --app-id app_example
spatius apps keys list --app-id app_example --page-size 20
spatius setup --app-id app_example
```

Use returned app IDs in place of `app_example`. `apps list` reads all pages and
retains its array output. Key lists return one page and `pagination.nextPageToken`;
pass it with `--page-token` and keep `--page-size` unchanged. App detail reports
the embedded key count without exposing keys. Creating an app does not create a
key. Creating a key does not select it locally. `setup --app-id` selects/reuses
credentials for rendering and may create a key if the app has none.

Keys are identified by the full SHA-256 `keyId` returned by create/list.
The Studio backend uses the raw key for deletion, but the CLI resolves the
fingerprint privately across all key pages, so never put a raw key in argv.
`apps keys list --show-secrets` and `apps keys create --show-secrets` explicitly
include raw keys in stdout. Only use this for an intended private destination;
do not capture that output in chat, logs, commits, issue bodies, or diagnostics.
Creation journals and ordinary outputs never store or reveal the new key.
Never read the credential file to retrieve keys.

## Session tokens

```sh
spatius apps session-tokens create --app-id app_example
```

This explicitly generates and returns a secret `sessionToken` on stdout, with
`operationId`, `appId`, `keyId`, `consoleOrigin`, `expireAt` (Unix seconds), and
`modelVersion`. The lifetime is 24 hours and `modelVersion` is empty, matching
the frontend. Keep the token in the intended private consumer; do not echo it
in chat, diagnostics, commits, or shared logs.

The CLI uses Studio login to fetch the first available app key. To select a
particular key, supply `--key-id <full-keyId>` from `apps keys list`. Selection
follows pagination and never substitutes another key for an explicit fingerprint.
`APP_KEY_UNAVAILABLE` means no matching key exists. Create a key explicitly if
needed; token generation never creates app credentials or changes local setup.

Issuance calls `POST /v1/console/session-tokens` at `SPATIUS_CONSOLE_URL` with
only `X-Api-Key` authentication. The Studio bearer token stays at the Studio
origin. The frontend selects Console by region; configure `SPATIUS_CONSOLE_URL`
to the intended region before login and subsequent CLI commands. CLI profiles
are scoped by both Studio and Console origins, so changing the region can
require login again. Redirects are rejected. This is the frontend's Console
session endpoint, not a `/v1/open` route or Studio CLI login token exchange.

An operation record containing the resolved key fingerprint and expiry is saved
before one POST. Neither the API key nor session token is saved in that record.
There is no `--resume` for session tokens: a lost stdout/response cannot recover
the issued token. On `SESSION_TOKEN_FAILED` or interruption, inspect the returned
operation ID and expiry. A token may already have been issued until `expireAt`;
do not automatically retry. Generate another only when a new issuance is intended.
For a Console rejection, check the selected key and configured region/access;
do not confuse Console key authentication with the Studio bearer login.

## Creation recovery

App and key creation commands persist their operation ID and resolved name/app ID before
one POST. Retain `operationId` from progress, result, or error output. Use
`apps create --resume <operation-id>` or `apps keys create --resume <operation-id>`
without new input to inspect the saved outcome. An accepted creation returns the
saved result. For keys, a resumed `--show-secrets` resolves the existing key by
fingerprint through Studio reads; it never creates another key.

`STUDIO_CREATION_UNCERTAIN` means submission may have succeeded. Resume never
replays it. Read `apps list` or `apps keys list --app-id <id>` and compare the
resolved input, timestamps, and known state. Names are not unique, so do not
assume a matching name proves which request created an app. If the outcome
remains unclear, explain it to the user. Only start a new creation without
`--resume` when a new attempt is intended after reconciliation.

`STUDIO_CREATION_REJECTED` means the saved request received a definite rejection.
Resolve the reported authentication, permission, input, or quota problem before
intentionally starting another operation. There are no automatic POST retries.

## Deletion and selection

When deletion is intended, use `apps delete <app-id>` or
`apps keys delete <full-keyId> --app-id <app-id>`. Deleting an app removes its
keys as well. Deleting a key can interrupt clients using that credential.
These commands perform the requested deletion directly; do not use them for
discovery or as examples to execute against an arbitrary app.

A matching cached CLI selection is invalidated before deletion is submitted,
including when its response is lost. Read the app/key list to reconcile an
interruption, then repeat the same deletion if needed. Already absent resources
are treated as deleted. To render again, intentionally run `setup` or
`setup --app-id <id>`; it may create replacement credentials.
