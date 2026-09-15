import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { registryVersions, type RegistryVersions } from './registry.js';

export const CACHE_FILE = 'update-check.json';
export const CHECK_INTERVAL = 24 * 3600_000;
export const FAILURE_INTERVAL = 3600_000;
const LOCK_LIFETIME = 30000;
export interface UpdateCache {
  schemaVersion: 1;
  attemptedAt: number;
  checkedAt?: number;
  versions?: RegistryVersions;
  failed: boolean;
}

export function readCache(
  directory: string,
  now = Date.now(),
): UpdateCache | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(directory, CACHE_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16384) return;
    const cache = JSON.parse(readFileSync(fd, 'utf8')) as UpdateCache;
    if (
      cache.schemaVersion !== 1 ||
      typeof cache.failed !== 'boolean' ||
      !Number.isSafeInteger(cache.attemptedAt) ||
      cache.attemptedAt < 0 ||
      cache.attemptedAt > now + 60000 ||
      (cache.checkedAt !== undefined &&
        (!Number.isSafeInteger(cache.checkedAt) ||
          cache.checkedAt < 0 ||
          cache.checkedAt > cache.attemptedAt))
    )
      return;
    const versions =
      cache.versions === undefined
        ? undefined
        : registryVersions(cache.versions);
    if ((!cache.failed || cache.checkedAt !== undefined) && !versions) return;
    return {
      schemaVersion: 1,
      attemptedAt: cache.attemptedAt,
      checkedAt: cache.checkedAt,
      versions,
      failed: cache.failed,
    };
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function needsCheck(
  cache: UpdateCache | undefined,
  now = Date.now(),
): boolean {
  return (
    !cache ||
    now - cache.attemptedAt >=
      (cache.failed ? FAILURE_INTERVAL : CHECK_INTERVAL)
  );
}

export function writeCache(directory: string, cache: UpdateCache): void {
  const temporary = join(directory, `.update-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(cache) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, join(directory, CACHE_FILE));
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function ownsLock(directory: string, nonce: string): boolean {
  try {
    return (
      readFileSync(join(directory, '.update-check-lock', 'owner'), 'utf8') ===
      nonce
    );
  } catch {
    return false;
  }
}

export function releaseLock(directory: string, nonce: string): void {
  if (ownsLock(directory, nonce))
    rmSync(join(directory, '.update-check-lock'), {
      recursive: true,
      force: true,
    });
}

export function acquireLock(
  directory: string,
  now = Date.now(),
): string | undefined {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    return;
  const lock = join(directory, '.update-check-lock');
  try {
    const existing = lstatSync(lock);
    if (
      !existing.isDirectory() ||
      existing.isSymbolicLink() ||
      now - existing.mtimeMs < LOCK_LIFETIME
    )
      return;
    const stale = `${lock}-${randomUUID()}`;
    renameSync(lock, stale);
    rmSync(stale, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    return;
  }
  const nonce = randomUUID();
  try {
    writeFileSync(join(lock, 'owner'), nonce, { flag: 'wx', mode: 0o600 });
    return nonce;
  } catch {
    rmSync(lock, { recursive: true, force: true });
    return;
  }
}
