# Inputs, presentation, and recovery

| Setting            | Default and allowed range                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Width / height     | Without a background: 1024 each. With a background: omitted, and the service follows the image. Even integers 64–1920, area ≤2,073,600                     |
| Fit                | Without a background: `crop`. With a background: omitted unless requested. `crop` fills the frame and can cut the avatar; `contain` keeps the whole avatar |
| Background color   | `#000000`; six-digit RGB hex                                                                                                                               |
| Background fit     | `cover`; `contain` or `stretch` also supported                                                                                                             |
| Lead-in / lead-out | 0; each 0–60 seconds of additional idle time                                                                                                               |

Only pass width, height, or fit with a background when the user asked for
them. A mismatch between the background's aspect ratio and the documented
defaults is not such a request.

The service controls encoding. Transitions can make output longer than the
audio even with zero additional idle time. Audio decoding and duration checks
happen in the renderer.

Temporary uploads are immutable and available for 24 hours after completion.
External URLs must remain accessible throughout preparation, which can take
up to 30 minutes. Source hosts must serve a supported media Content-Type, not
`application/octet-stream`. Public HTTP(S) and signed URLs work; private-network
URLs and embedded username/password credentials do not.

Video retry identity includes its normalized request body. The same UUID with
different resolved URLs conflicts, even if the underlying local file is the same.
Resume preserves the exact request. Never refresh or replace those input URLs
after submission became uncertain. A terminal failure requires an intentional
new operation, not an automatic retry of the failed job.

Output is currently retained seven days after render submission; use the returned
`job.expiresAt`. Signed output links currently last up to 15 minutes, capped by
retention. `videos download` refreshes the link. Downloading or refreshing a link
does not extend output retention.

Downloads require a direct HTTPS output link; the CLI does not follow redirects
or forward Studio/App credentials to storage. For `DOWNLOAD_UNAVAILABLE`, repeat
`videos download` to request a fresh link. Do not work around a redirect rejection
by attaching credentials to another host.
