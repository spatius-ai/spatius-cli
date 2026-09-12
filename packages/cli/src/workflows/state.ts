import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
  chmod,
  open,
} from 'node:fs/promises';
import { join } from 'node:path';
import { UUID_PATTERN } from '@spatius/contracts';
import { CliError } from '../core/errors.js';

export function identifier(value: string, label = 'ID'): string {
  if (!UUID_PATTERN.test(value))
    throw new CliError('INVALID_ARGUMENT', `${label} must be a UUID.`, {
      exitCode: 2,
    });
  return value.toLowerCase();
}

/** Journals contain signed source URLs, so treat the entire directory as private. */
export class StateStore {
  readonly directory: string;
  constructor(root: string, profileKey: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(profileKey))
      throw new CliError('INVALID_PROFILE', 'Invalid account profile.');
    this.directory = join(root, 'operations', profileKey);
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }
  async read<T>(id: string): Promise<T> {
    try {
      return JSON.parse(
        await readFile(join(this.directory, `${identifier(id)}.json`), 'utf8'),
      ) as T;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new CliError(
          'OPERATION_UNREADABLE',
          'The saved operation cannot be read. Preserve it for recovery; do not submit another creation automatically.',
        );
      throw new CliError(
        'OPERATION_NOT_FOUND',
        'No saved operation exists for this account and ID.',
        {
          recovery:
            'Use the operation ID returned by the original command under the same Studio account.',
        },
      );
    }
  }
  async write(id: string, value: unknown): Promise<void> {
    await this.initialize();
    const target = join(this.directory, `${identifier(id)}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      // Make the renamed entry durable before a non-idempotent remote request.
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    await this.initialize();
    const path = join(this.directory, `${identifier(id)}.lock`);
    for (let attempt = 0; ; attempt++) {
      try {
        await writeFile(path, String(process.pid), { mode: 0o600, flag: 'wx' });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let alive = true;
        try {
          const pid = Number(await readFile(path, 'utf8'));
          if (pid > 0) process.kill(pid, 0);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
        }
        if (alive || attempt > 0)
          throw new CliError(
            'OPERATION_BUSY',
            'This operation is already running in another process.',
            { retryable: true },
          );
        await unlink(path).catch(() => {});
      }
    }
    try {
      return await run();
    } finally {
      await unlink(path).catch(() => {});
    }
  }
}
