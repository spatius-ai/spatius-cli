# Staging validation

Validated on 2026-09-12 UTC. This is a staging record, not a production release.

Final `pnpm check` passed on Node.js 22.23.2: **58 CLI tests, 27 Worker tests**,
three packaged skills with 29 validated examples, type checks, lint, formatting,
npm artifact installation, and the Worker deployment dry run.

| Check                              | Result                                                  |
| ---------------------------------- | ------------------------------------------------------- |
| Studio browser login               | Passed with the real API and browser approval origins   |
| App bootstrap                      | Passed; two setup calls reused the same dedicated app   |
| Authenticated temporary upload     | Passed with a 649,644-byte real speech WAV              |
| Signed input download              | HTTP 200; byte count and SHA-256 matched the source     |
| Missing login / tampered signature | Rejected with HTTP 401 / 403                            |
| Avatar list                        | HTTP 200; the account currently has no owned avatars    |
| Video creation                     | Passed by resuming the original saved request           |
| Video list                         | HTTP 200; exactly one succeeded job                     |
| Video polling                      | Observed processing/rendering, then succeeded/completed |
| MP4 download and decoding          | Passed; 1024×1024, 25 fps, H.264/AAC, 22.08 seconds     |
| Live avatar creation               | Not run; remains a separate release check               |

The staging Worker is
`https://spatius-cli-media-staging.472617147.workers.dev`, backed by the private
`spatius-cli-media-staging` R2 bucket. Lifecycle fallback rules delete objects
after two days and abort multipart uploads after one day; the application
enforces its shorter upload and signed-link deadlines.

The original saved video operation was resumed after the Console deployment and
access updates. Console accepted the request and completed it in approximately
47 seconds. The CLI polled the job, refreshed its signed output link, and saved
a 2,285,695-byte MP4. `ffprobe` confirmed H.264 video at 1024×1024 and 25 fps,
with mono 16 kHz AAC audio; both streams are 22.08 seconds long. A full `ffmpeg`
decode completed without errors. The account's job list contained exactly one
succeeded job after the retry.

The operation, credentials, and input links remain in the private CLI
configuration directory. Do not put account identifiers, input URLs, keys, or
tokens in public validation reports. The authenticated upload-to-video workflow
has passed; live portrait-to-avatar creation remains a separate release check.

Automated checks cover login and app recovery, multipart limits and leases,
native Worker request construction, interrupted submission and resume, polling,
download, terminal failures, packaged skills, and npm installation. The Worker
suite also streams a complete 500 MiB upload through 63 local R2 parts. See
`pnpm check` and [the deployment guide](deployment.md) for repeatable checks.
