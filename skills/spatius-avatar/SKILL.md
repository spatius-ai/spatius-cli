---
name: spatius-avatar
description: List public and custom Studio avatars, create Spatius avatars from portrait images, and poll avatar creation jobs with Spatius CLI. Use for avatar discovery, creation, and recovery, including preparing local image inputs.
license: MIT
---

# Create a Spatius avatar

For discovery, Studio login is sufficient; no app setup or Open API enablement
is required. Choose a collection explicitly:

```sh
spatius avatars list --type public --page-size 20
spatius avatars list --type custom --status success,generating --page-size 20
```

`avatars list` defaults to `custom` and now reads Studio's custom collection,
including completed avatars and pending/failed creation applications. Results
contain `type`, `avatars`, `pagination.nextPageToken`, and custom status `counts`
when supplied by Studio. Request the next page with `--page-token`, retaining
the collection, page size, and filters. Custom status filters accept
`success`, `generating`, and `failure`; omit the filter for all statuses.
Public lists reject `--status`. An empty page is valid; follow its next token
when present. On 401, log in; on 403, check Studio permission rather than running
setup or repeatedly retrying. A failed application is not a reason to create
another avatar automatically.

Public items use `id` as the avatar ID. Custom items distinguish the display
`id`, renderable `avatarId`, and creation `applyId`; do not pass a pending
application's `id` or `applyId` to a video request. Use a successful custom item's
`avatarId` once available. Listing does not grant render permission.
`avatars get`, avatar creation/jobs, and video workflows retain their Open API
behavior and need setup and service access.

Check `spatius auth status` and use the shared setup skill if login or app setup
is missing. Read `spatius schema avatars create` for installed command details.

Use an existing local portrait or the user's public URL. The image must be JPEG
or PNG, at most 5 MiB, with its shorter side at least 340 pixels. PNG must be
opaque; the portrait must contain one clearly visible face. These requirements
are finally checked by the service. Do not assume an accepted job has passed them.

```sh
spatius avatars create --image ./portrait.png --name Presenter --dry-run
spatius avatars create --image ./portrait.png --name Presenter
```

Use the actual input path. Local files upload automatically; URL inputs are
passed to the service. Avatar creation consumes the user's existing Avatar
Creations allowance. Return promptly after acceptance, retaining `operationId`
and `jobId`, then wait or inspect:

```sh
spatius avatars jobs wait 00000000-0000-4000-8000-000000000001 --timeout 600
```

Replace the example UUID with the returned job ID. On success use `job.avatarId`
for a video request. A wait timeout preserves the job; run wait/get again.

On a preparation interruption, resume with
`spatius avatars create --resume <operation-id>`. An uncertain submission cannot
be repeated safely: this API has no creation retry key. If the CLI returns
`SUBMISSION_UNCERTAIN`, inspect recent jobs or ask the user to reconcile the
operation. Never automatically submit another avatar because the response was lost.

Fix a failed image or permission issue before proposing a replacement creation.
Do not retry terminal jobs in a loop, even when `job.error.retryable` is true.
