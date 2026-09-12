import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError } from '../core/errors.js';

export interface Profile {
  userId: string;
  consoleOrigin: string;
  studioOrigin: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshPending?: boolean;
  appId?: string;
  apiKey?: string;
  pendingApp?: boolean;
  pendingKey?: boolean;
}

export interface State {
  version: 1;
  active: Record<string, string>;
  profiles: Record<string, Profile>;
}

function ioError(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

export function defaultDirectory(): string {
  if (process.platform === 'win32')
    return join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'Spatius',
    );
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config'),
    'spatius',
  );
}

function unsafe(): CliError {
  return new CliError(
    'UNSAFE_AUTH_STORAGE',
    'The credential path is not a private regular file or directory.',
    {
      recovery:
        'Use a private configuration directory owned by your user; remove symbolic links or shared credential files.',
    },
  );
}

export class AuthStorage {
  readonly directory: string;
  private readonly filename: string;

  constructor(directory = defaultDirectory()) {
    if (!isAbsolute(directory))
      throw new CliError(
        'INVALID_CONFIG',
        'The configuration directory must be an absolute path.',
      );
    this.directory = directory;
    this.filename = join(directory, 'auth.json');
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw unsafe();
    if (process.platform !== 'win32') await chmod(this.directory, 0o700);
  }

  async read(): Promise<State> {
    try {
      const directory = await lstat(this.directory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (process.getuid && directory.uid !== process.getuid())
      )
        throw unsafe();
    } catch (error) {
      if (ioError(error) === 'ENOENT')
        return { version: 1, active: {}, profiles: {} };
      throw error;
    }
    let file;
    try {
      file = await open(
        this.filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (ioError(error) === 'ENOENT')
        return { version: 1, active: {}, profiles: {} };
      if (ioError(error) === 'ELOOP') throw unsafe();
      throw error;
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 1024 * 1024 ||
        (process.getuid && info.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      )
        throw unsafe();
      const state: unknown = JSON.parse(await file.readFile('utf8'));
      if (!validState(state)) throw new Error('Invalid auth state');
      return state;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        'AUTH_STATE_INVALID',
        'The saved login state could not be read.',
        {
          recovery:
            'Restore the private auth.json file from a known backup, or remove it and run spatius auth login.',
        },
      );
    } finally {
      await file.close();
    }
  }

  async write(state: State): Promise<void> {
    const temporary = join(this.directory, `.auth-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, this.filename);
      // Persist the rename before a token-consuming network request continues.
      if (process.platform !== 'win32') {
        const dir = await open(dirname(this.filename), 'r');
        try {
          await dir.sync();
        } finally {
          await dir.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async locked<T>(operation: (state: State) => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const lock = join(this.directory, '.auth-lock');
    const ownerFile = join(lock, 'owner.json');
    const nonce = randomUUID();
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        const owner = await open(ownerFile, 'wx', 0o600);
        try {
          await owner.writeFile(JSON.stringify({ pid: process.pid, nonce }));
        } finally {
          await owner.close();
        }
        break;
      } catch (error) {
        if (ioError(error) !== 'EEXIST') throw error;
        const lockInfo = await lstat(lock).catch(() => undefined);
        if (lockInfo && (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()))
          throw unsafe();
        let abandoned = false;
        try {
          const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as {
            pid: number;
          };
          if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw unsafe();
          try {
            process.kill(owner.pid, 0);
          } catch (error) {
            abandoned = ioError(error) === 'ESRCH';
          }
        } catch (error) {
          if (error instanceof CliError) throw error;
          const info = await stat(lock).catch(() => undefined);
          abandoned = !!info && Date.now() - info.mtimeMs > 30_000;
        }
        if (abandoned) {
          // Rename gives only one contender ownership of removing an abandoned lock.
          const stale = `${lock}.stale-${nonce}`;
          try {
            await rename(lock, stale);
            await rm(stale, { recursive: true, force: true });
          } catch (error) {
            if (ioError(error) !== 'ENOENT') throw error;
          }
          continue;
        }
        if (Date.now() >= deadline)
          throw new CliError(
            'AUTH_BUSY',
            'Another Spatius command is updating login state.',
            {
              retryable: true,
              recovery: 'Wait for the other command to finish, then retry.',
            },
          );
        await delay(50);
      }
    }
    try {
      return await operation(await this.read());
    } finally {
      const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as {
        nonce: string;
      };
      if (owner.nonce === nonce)
        await rm(lock, { recursive: true, force: true });
    }
  }
}

function validState(value: unknown): value is State {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as State;
  if (
    state.version !== 1 ||
    !state.active ||
    !state.profiles ||
    typeof state.active !== 'object' ||
    typeof state.profiles !== 'object' ||
    Array.isArray(state.active) ||
    Array.isArray(state.profiles)
  )
    return false;
  if (!Object.values(state.active).every((v) => typeof v === 'string'))
    return false;
  return Object.values(state.profiles).every(
    (profile) =>
      profile &&
      typeof profile === 'object' &&
      typeof profile.userId === 'string' &&
      typeof profile.consoleOrigin === 'string' &&
      typeof profile.studioOrigin === 'string' &&
      ['accessToken', 'refreshToken', 'expiresAt', 'appId', 'apiKey'].every(
        (key) =>
          profile[key as keyof Profile] === undefined ||
          typeof profile[key as keyof Profile] === 'string',
      ) &&
      ['refreshPending', 'pendingApp', 'pendingKey'].every(
        (key) =>
          profile[key as keyof Profile] === undefined ||
          typeof profile[key as keyof Profile] === 'boolean',
      ),
  );
}
