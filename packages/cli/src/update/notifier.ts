import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDirectory } from '../auth/storage.js';
import {
  acquireLock,
  needsCheck,
  readCache,
  releaseLock,
  writeCache,
} from './cache.js';
import { selectVersion } from './registry.js';

export interface UpdateNotice {
  currentVersion: string;
  latestVersion: string;
  message: string;
  command: 'spatius update';
}
export interface CheckLaunch {
  directory: string;
  nonce: string;
  onError: () => void;
}

export function launchCheck({ directory, nonce, onError }: CheckLaunch): void {
  const source = new URL(import.meta.url).pathname.endsWith(
    '/src/update/notifier.ts',
  );
  const helper = fileURLToPath(
    new URL(
      source ? './check-worker.ts' : './update-check.js',
      import.meta.url,
    ),
  );
  const child = spawn(
    process.execPath,
    [...(source ? process.execArgv : []), helper, directory, nonce],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.once('error', onError);
  child.unref();
}

export function createNotifier(options: {
  version: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  launch?: (request: CheckLaunch) => void;
}): { notice?: UpdateNotice; finish: () => void } {
  const empty = { finish: () => {} };
  const env = options.env ?? process.env;
  const command = options.args.find((arg) => !arg.startsWith('-'));
  if (
    env.SPATIUS_NO_UPDATE_NOTIFIER === '1' ||
    command === 'install' ||
    command === 'update' ||
    options.args.includes('--dry-run')
  )
    return empty;
  const directory = env.SPATIUS_CONFIG_DIR ?? defaultDirectory();
  if (!isAbsolute(directory)) return empty;
  const now = options.now ?? Date.now;
  let notice: UpdateNotice | undefined;
  try {
    const cached = readCache(directory, now());
    if (cached?.versions) {
      const target = selectVersion(options.version, cached.versions);
      if (target !== options.version)
        notice = {
          currentVersion: options.version,
          latestVersion: target,
          message: `Spatius ${target} is available (installed ${options.version}). Run spatius update.`,
          command: 'spatius update',
        };
    }
  } catch {
    /* An invalid cache is never a command error. */
  }
  let finished = false;
  return {
    notice,
    finish: () => {
      if (finished) return;
      finished = true;
      if (
        !options.args.length ||
        options.args.some((arg) =>
          ['--help', '-h', '--version', '-V'].includes(arg),
        )
      )
        return;
      let nonce: string | undefined;
      try {
        if (!needsCheck(readCache(directory, now()), now())) return;
        nonce = acquireLock(directory, now());
        if (!nonce) return;
        const owner = nonce;
        const onError = () => {
          try {
            writeCache(directory, {
              ...readCache(directory, now()),
              schemaVersion: 1,
              attemptedAt: now(),
              failed: true,
            });
            releaseLock(directory, owner);
          } catch {
            /* Best effort. */
          }
        };
        try {
          (options.launch ?? launchCheck)({ directory, nonce, onError });
        } catch {
          onError();
        }
      } catch {
        if (nonce) {
          try {
            releaseLock(directory, nonce);
          } catch {
            /* Best effort. */
          }
        }
      }
    },
  };
}
