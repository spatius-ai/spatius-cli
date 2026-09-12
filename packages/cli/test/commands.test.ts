import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram, commandSchema } from '../src/commands.js';
import { AuthManager } from '../src/auth/index.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('Agent command contract', () => {
  it('discovers actual command options without initializing credentials', async () => {
    let result: unknown;
    const program = buildProgram(
      () => {
        throw new Error('Discovery must not read credentials');
      },
      (data) => {
        result = data;
      },
      'test',
    );
    await program.parseAsync(['node', 'spatius', 'schema', 'videos', 'create']);
    expect(result).toMatchObject({
      commands: [
        {
          path: 'videos create',
          options: expect.arrayContaining([
            expect.objectContaining({ flags: '--request-id <uuid>' }),
            expect.objectContaining({ flags: '--resume <operation-id>' }),
          ]),
        },
      ],
    });
    expect(commandSchema().exitCodes[3]).toBe('wait deadline');
  });
  it('rejects unknown presentation choices before creating a context', async () => {
    const program = buildProgram(
      () => {
        throw new Error('Should not execute');
      },
      () => {},
      'test',
    );
    program.configureOutput({ writeErr: () => {} });
    await expect(
      program.parseAsync([
        'node',
        'spatius',
        'videos',
        'create',
        '--fit',
        'stretch',
      ]),
    ).rejects.toMatchObject({ exitCode: 1 });
  });
  it('keeps missing login distinct from a job wait deadline and rejects symlinked auth roots', async () => {
    const base = await mkdtemp(join(tmpdir(), 'spatius-command-'));
    directories.push(base);
    const opts = {
      studioOrigin: 'https://studio.example',
      consoleOrigin: 'https://console.example',
      mediaOrigin: 'https://media.example',
    };
    await expect(
      new AuthManager({ ...opts, configDir: join(base, 'missing') }).identity(),
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      options: { exitCode: 1 },
    });
    const target = join(base, 'target');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target);
    await symlink(target, join(base, 'linked'));
    await expect(
      new AuthManager({ ...opts, configDir: join(base, 'linked') }).status(),
    ).rejects.toMatchObject({ code: 'UNSAFE_AUTH_STORAGE' });
  });
});
