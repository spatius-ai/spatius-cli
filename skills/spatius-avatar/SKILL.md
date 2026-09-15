---
name: spatius-avatar
description: Create Spatius avatars from portrait images, inspect account avatars, and poll avatar creation jobs with Spatius CLI. Use for avatar creation and recovery, including preparing local image inputs.
license: MIT
metadata:
  version: '0.1.0-beta.0'
---

# Create a Spatius avatar

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
