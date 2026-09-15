// Import only version operations; range parsing is unnecessary on CLI startup.
import compare from 'semver/functions/compare.js';
import prerelease from 'semver/functions/prerelease.js';
import valid from 'semver/functions/valid.js';
import { CliError } from '../core/errors.js';

export type Channel = 'latest' | 'beta';
export type RegistryVersions = Partial<Record<Channel, string>>;
export function isVersion(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 256 && valid(value) === value
  );
}
export function registryVersions(value: unknown): RegistryVersions {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid npm tags.');
  const tags = value as Record<string, unknown>;
  const result: RegistryVersions = {};
  for (const tag of ['latest', 'beta'] as const) {
    if (tags[tag] === undefined) continue;
    if (
      !isVersion(tags[tag]) ||
      (tag === 'latest' && prerelease(tags[tag]) !== null)
    )
      throw new Error('Invalid npm release version.');
    result[tag] = tags[tag];
  }
  if (!result.latest && !result.beta) throw new Error('No npm release tags.');
  return result;
}

export function selectVersion(
  current: string,
  versions: RegistryVersions,
  channel?: Channel,
): string {
  if (!isVersion(current)) throw new Error('Invalid current CLI version.');
  const tags = registryVersions(versions);
  const candidates = channel
    ? [tags[channel]]
    : prerelease(current)
      ? [tags.beta, tags.latest]
      : [tags.latest];
  const available = candidates.filter(
    (value): value is string => value !== undefined,
  );
  if (!available.length)
    throw new Error('Selected npm release channel is unavailable.');
  const target = available.sort(compare).at(-1)!;
  return compare(target, current) > 0 ? target : current;
}

export async function fetchVersions(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<RegistryVersions> {
  try {
    const response = await fetcher(
      'https://registry.npmjs.org/-/package/@spatius%2Fcli/dist-tags',
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        redirect: 'error',
        headers: { 'Cache-Control': 'no-cache', Accept: 'application/json' },
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('npm registry request failed.');
    }
    // dist-tags is small; do not consume an unbounded or unexpected response.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty registry response.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16384) throw new Error('Registry response too large.');
        chunks.push(value);
      }
      return registryVersions(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
    } finally {
      await reader.cancel();
    }
  } catch {
    if (signal.aborted)
      throw new CliError('INTERRUPTED', 'Update interrupted.', {
        exitCode: 130,
      });
    throw new CliError(
      'UPDATE_REGISTRY_UNAVAILABLE',
      'Could not read valid release versions from npm.',
      {
        retryable: true,
        recovery:
          'Check the npm registry connection, then rerun spatius update.',
      },
    );
  }
}
