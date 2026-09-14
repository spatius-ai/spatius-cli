import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PACKAGE_NAME = '@spatius/cli';
export const REPOSITORY = 'spatius-ai/spatius-cli';
export const MEDIA_URL = 'https://cli-media.spatius.ai';

export function validateRelease(event) {
  if (
    event?.action !== 'published' ||
    event.release?.draft !== false ||
    typeof event.release?.prerelease !== 'boolean'
  )
    throw new Error('Expected a published, non-draft GitHub release.');
  if (
    event.repository?.full_name !== REPOSITORY ||
    event.repository?.private !== false
  )
    throw new Error(
      'Release publishing requires the public ' + REPOSITORY + ' repository.',
    );
  const tag = event.release.tag_name;
  const match =
    typeof tag === 'string' &&
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      tag,
    );
  if (
    !match ||
    match[0] !== tag ||
    tag.length > 256 ||
    match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part))) ||
    match[4]
      ?.split('.')
      .some((part) => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))
  )
    throw new Error(
      'Release tag must be canonical vX.Y.Z[-prerelease], without build metadata.',
    );
  if (Boolean(match[4]) !== event.release.prerelease)
    throw new Error(
      'The GitHub prerelease checkbox must match the release tag.',
    );
  return { tag, version: tag.slice(1), distTag: match[4] ? 'beta' : 'latest' };
}

export function validateCheckout(root, tag, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? ''))
    throw new Error('A full GitHub release commit SHA is required.');
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  if (
    git('rev-parse', 'HEAD') !== sha ||
    git('rev-parse', 'refs/tags/' + tag + '^{commit}') !== sha
  )
    throw new Error(
      'The checkout and release tag must match the original release commit.',
    );
  try {
    git('merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main');
  } catch {
    throw new Error('The release commit must be reachable from origin/main.');
  }
}

export async function requireUnpublished(version, fetcher = fetch) {
  const response = await fetcher(
    'https://registry.npmjs.org/' +
      encodeURIComponent(PACKAGE_NAME) +
      '/' +
      encodeURIComponent(version),
    {
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      headers: { 'Cache-Control': 'no-cache' },
    },
  );
  await response.body?.cancel();
  if (response.status === 200)
    throw new Error(
      PACKAGE_NAME +
        '@' +
        version +
        ' already exists on npm. Check the previous run; choose a new version for changes.',
    );
  if (response.status !== 404)
    throw new Error(
      'npm version lookup failed (HTTP ' +
        response.status +
        '); cannot confirm that this version is unpublished.',
    );
}

export function integrity(bytes) {
  return 'sha512-' + createHash('sha512').update(bytes).digest('base64');
}

export async function verifyArtifact(directory, version) {
  const metadata = JSON.parse(
    await readFile(join(directory, 'release-artifact.json'), 'utf8'),
  );
  const filename = 'spatius-cli-' + version + '.tgz';
  if (
    metadata.name !== PACKAGE_NAME ||
    metadata.version !== version ||
    metadata.filename !== filename ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.integrity ?? '')
  )
    throw new Error(
      'The release artifact metadata does not match the requested package/version.',
    );
  const tarball = join(directory, filename);
  if (integrity(await readFile(tarball)) !== metadata.integrity)
    throw new Error('The release tarball integrity check failed.');
  return { ...metadata, tarball };
}

export function deploymentVersion(contents) {
  const entries = contents
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const deployments = entries.filter((entry) => entry.type === 'deploy');
  if (
    deployments.length !== 1 ||
    deployments[0].version !== 1 ||
    deployments[0].worker_name !== 'spatius-cli-media' ||
    deployments[0].wrangler_environment !== 'production' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
      deployments[0].version_id ?? '',
    )
  )
    throw new Error(
      'Wrangler did not report one identifiable production Worker deployment.',
    );
  return deployments[0].version_id;
}

export async function checkDeployment({
  fetcher = fetch,
  sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(done, ms);
      function done() {
        signal.removeEventListener('abort', abort);
        resolve();
      }
      function abort() {
        clearTimeout(timer);
        reject(signal.reason);
      }
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }),
  attempts = 12,
  signal = AbortSignal.timeout(120_000),
} = {}) {
  let reason = 'No successful response.';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal.throwIfAborted();
    try {
      const options = {
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      };
      const health = await fetcher(MEDIA_URL + '/health', options);
      if (health.status !== 200 || (await health.json()).status !== 'ok')
        throw new Error('Worker health check did not return status ok.');
      // No credentials and no mutation: authentication runs before method dispatch.
      const denied = await fetcher(MEDIA_URL + '/v1/uploads', {
        ...options,
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
      if (
        denied.status !== 401 ||
        (await denied.json()).error?.code !== 'unauthenticated'
      )
        throw new Error(
          'Worker upload management did not reject unauthenticated access.',
        );
      return;
    } catch (error) {
      reason = error.message;
      if (attempt < attempts) await sleep(5_000, signal);
    }
  }
  throw new Error(
    'Production Worker checks failed after bounded retries: ' + reason,
  );
}
