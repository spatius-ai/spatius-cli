# Studio apps and keys

All commands below use the Studio bearer login at `SPATIUS_STUDIO_URL`.
They do not use Open API credentials. Inspect `spatius schema apps create`
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

## Creation recovery

Both creation commands persist their operation ID and resolved name/app ID before
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
