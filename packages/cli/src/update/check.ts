import {
  needsCheck,
  ownsLock,
  readCache,
  releaseLock,
  writeCache,
} from './cache.js';
import { fetchVersions } from './registry.js';

export async function checkForUpdates(
  directory: string,
  nonce: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  try {
    if (!ownsLock(directory, nonce)) return;
    const previous = readCache(directory);
    if (!needsCheck(previous)) return;
    try {
      const versions = await fetchVersions(signal, fetcher);
      const now = Date.now();
      if (ownsLock(directory, nonce))
        writeCache(directory, {
          schemaVersion: 1,
          attemptedAt: now,
          checkedAt: now,
          versions,
          failed: false,
        });
    } catch {
      if (ownsLock(directory, nonce))
        writeCache(directory, {
          ...previous,
          schemaVersion: 1,
          attemptedAt: Date.now(),
          failed: true,
        });
    }
  } catch {
    /* Registry and cache failures stay silent. */
  } finally {
    try {
      releaseLock(directory, nonce);
    } catch {
      /* Expired locks recover on the next run. */
    }
  }
}
