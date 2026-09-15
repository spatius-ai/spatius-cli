import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  detectCompletionShell,
  installShellCompletions,
} from '../src/install/completions.js';
import { completionScript, completionShells } from '../src/completions.js';
import type { ProcessRequest } from '../src/install/process.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "spatius shell's home "));
  directories.push(home);
  return {
    home,
    cwd: home,
    environment: {} as NodeJS.ProcessEnv,
    signal: new AbortController().signal,
  };
}

describe('installer shell detection', () => {
  const options = () => ({
    environment: { SHELL: '/bin/bash' },
    platform: 'darwin' as NodeJS.Platform,
    cwd: tmpdir(),
    signal: new AbortController().signal,
    parentPid: 100,
    runner: vi.fn(async (_request: ProcessRequest) => ({
      code: 0,
      stdout: '',
      stderr: '',
    })),
  });
  it('walks through npx node/sh wrappers to the launching shell instead of assuming SHELL', async () => {
    const o = options();
    o.runner
      .mockResolvedValueOnce({ code: 0, stdout: '101 /bin/sh\n', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '102 npm exec @spatius/cli install\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 0, stdout: '103 -zsh\n', stderr: '' });
    expect(await detectCompletionShell(o)).toEqual({
      supported: true,
      shell: 'zsh',
      source: 'launching process',
    });
    expect(o.runner.mock.calls.map(([request]) => request.args)).toEqual([
      ['-p', '100', '-o', 'ppid=', '-o', 'comm='],
      ['-p', '101', '-o', 'ppid=', '-o', 'comm='],
      ['-p', '102', '-o', 'ppid=', '-o', 'comm='],
    ]);
  });
  it('falls back to the configured login shell if process inspection is unavailable', async () => {
    const o = options();
    o.runner.mockRejectedValue(new Error('ps unavailable'));
    expect(await detectCompletionShell(o)).toMatchObject({
      shell: 'bash',
      source: 'login shell (SHELL)',
    });
  });
  it('does not assume Bash for an unknown shell and avoids probing on Windows', async () => {
    const o = options();
    o.environment.SHELL = '/bin/nu';
    expect((await detectCompletionShell(o)).shell).toBeUndefined();
    o.runner.mockClear();
    expect(await detectCompletionShell({ ...o, platform: 'win32' })).toEqual({
      supported: false,
    });
    expect(o.runner).not.toHaveBeenCalled();
  });
  it('bounds ancestor traversal and respects cancellation', async () => {
    const o = options();
    o.runner.mockImplementation(async (r) => ({
      code: 0,
      stdout: `${Number(r.args[1]) + 1} node`,
      stderr: '',
    }));
    await detectCompletionShell(o);
    expect(o.runner).toHaveBeenCalledTimes(12);
    const controller = new AbortController();
    controller.abort();
    await expect(
      detectCompletionShell({ ...o, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'INTERRUPTED' });
  });
});

describe('persistent completion setup', () => {
  it.skipIf(spawnSync('zsh', ['--version']).status !== 0 && !process.env.CI)(
    'excludes insecure Zsh completion directories without prompting or aborting setup',
    async () => {
      const o = await fixture();
      const insecure = join(o.home, 'insecure-completions');
      await mkdir(insecure);
      await chmod(insecure, 0o777);
      await writeFile(
        join(insecure, '_spatius_unsafe'),
        '#compdef spatius-unsafe\n',
      );
      await writeFile(
        join(o.home, '.zshenv'),
        'fpath=("$ZDOTDIR/insecure-completions" $fpath)\n',
      );
      const installed = await installShellCompletions('zsh', o);
      const env = { ...process.env, HOME: o.home, ZDOTDIR: o.home };
      const inspect =
        'print -r -- "spatius=${_comps[spatius]-} unsafe=${_comps[spatius-unsafe]-}"';
      for (const args of [
        ['-d', '-ic', inspect],
        [
          '-d',
          '-c',
          installed.activation.split('or run:\n')[1]! + '\n' + inspect,
        ],
      ]) {
        const result = spawnSync('zsh', args, { env, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('spatius=_spatius unsafe=\n');
      }
    },
  );
  for (const shell of completionShells) {
    const available = spawnSync(shell, ['--version']).status === 0;
    it.skipIf(!available && !process.env.CI)(
      `loads the installed ${shell} configuration in a real shell`,
      async () => {
        const o = await fixture();
        const installed = await installShellCompletions(shell, o);
        const env = {
          ...process.env,
          HOME: o.home,
          XDG_CONFIG_HOME: join(o.home, '.config'),
          XDG_CACHE_HOME: join(o.home, '.cache'),
          ZDOTDIR: o.home,
        };
        const result =
          shell === 'fish'
            ? spawnSync(
                shell,
                [
                  '--no-config',
                  '-c',
                  'source "$argv[1]"; functions -q __spatius_complete',
                  installed.files[0]!,
                ],
                { env, encoding: 'utf8' },
              )
            : shell === 'bash'
              ? spawnSync(
                  shell,
                  [
                    '--noprofile',
                    '--rcfile',
                    installed.files[1]!,
                    '-ic',
                    'complete -p spatius',
                  ],
                  { env, encoding: 'utf8' },
                )
              : spawnSync(
                  shell,
                  ['-d', '-ic', 'print -r -- $_comps[spatius]'],
                  { env, encoding: 'utf8' },
                );
        expect(result.status, result.stderr).toBe(0);
        if (shell === 'zsh') expect(result.stderr).toBe('');
        if (shell !== 'fish') expect(result.stdout).toContain('_spatius');
        // Printed activation commands must also handle spaces and apostrophes in paths.
        const activate = spawnSync(
          shell,
          ['-c', installed.activation.split('or run:\n')[1]!],
          { env, encoding: 'utf8' },
        );
        expect(activate.status, activate.stderr).toBe(0);
        expect(activate.stderr).toBe('');
      },
    );
  }
  it.each(completionShells)(
    'installs %s scripts independently of the npx cache and is idempotent',
    async (shell) => {
      const o = await fixture();
      o.cwd = join(o.home, '_npx', 'temporary');
      const first = await installShellCompletions(shell, o);
      expect(await readFile(first.files[0]!, 'utf8')).toBe(
        completionScript(shell),
      );
      expect(first.files.every((file) => !file.includes('_npx'))).toBe(true);
      const second = await installShellCompletions(shell, o);
      expect(second.backups).toEqual([]);
      expect(second.activation).toContain('Open a new terminal');
      for (const file of first.files.slice(1)) {
        const content = await readFile(file, 'utf8');
        expect(content.match(/# >>> spatius completions >>>/g)).toHaveLength(1);
      }
    },
  );
  it('preserves Bash profiles, permissions, and the first existing login-file choice', async () => {
    const o = await fixture();
    const profile = join(o.home, '.profile');
    await writeFile(profile, '# existing login settings\nexport EXAMPLE=1\n', {
      mode: 0o600,
    });
    await writeFile(join(o.home, '.bashrc'), '# existing interactive settings');
    const result = await installShellCompletions('bash', o);
    expect(result.files).toContain(profile);
    expect(await readdir(o.home)).not.toContain('.bash_profile');
    expect(await readFile(profile, 'utf8')).toContain(
      '# existing login settings\nexport EXAMPLE=1\n',
    );
    expect((await stat(profile)).mode & 0o777).toBe(0o600);
    expect(
      await readFile(
        result.backups.find((file) => file.startsWith(profile))!,
        'utf8',
      ),
    ).toBe('# existing login settings\nexport EXAMPLE=1\n');
  });
  it('honors XDG and ZDOTDIR and keeps symlinked dotfiles intact', async () => {
    const o = await fixture();
    o.environment = {
      ZDOTDIR: join(o.home, 'zsh config'),
      XDG_DATA_HOME: join(o.home, 'data'),
      XDG_CONFIG_HOME: join(o.home, 'config'),
    };
    await mkdir(o.environment.ZDOTDIR!);
    const target = join(o.home, 'managed-zshrc');
    await writeFile(
      target,
      '# framework initialization\nautoload -Uz compinit; compinit\n',
    );
    const profile = join(o.environment.ZDOTDIR!, '.zshrc');
    await symlink(target, profile);
    const zsh = await installShellCompletions('zsh', o);
    expect((await lstat(profile)).isSymbolicLink()).toBe(true);
    expect(zsh.files[0]).toBe(
      join(o.home, 'data/spatius/completions/spatius.zsh'),
    );
    expect(await readFile(target, 'utf8')).toContain(
      '# framework initialization',
    );
    expect(zsh.backups[0]).toContain('managed-zshrc.spatius-backup-');
    const fish = await installShellCompletions('fish', o);
    expect(fish.files).toEqual([
      join(o.home, 'config/fish/completions/spatius.fish'),
    ]);
  });
  it('updates its managed block without duplicating it or changing surrounding text', async () => {
    const o = await fixture();
    const profile = join(o.home, '.zshrc');
    await writeFile(
      profile,
      '# before\r\n# >>> spatius completions >>>\r\nold setup\r\n# <<< spatius completions <<<\r\n# after\r\n',
    );
    await installShellCompletions('zsh', o);
    const contents = await readFile(profile, 'utf8');
    expect(contents.startsWith('# before\r\n')).toBe(true);
    expect(contents.endsWith('# after\r\n')).toBe(true);
    expect(contents).not.toContain('old setup');
    expect(contents.match(/# >>> spatius completions >>>/g)).toHaveLength(1);
  });
  it('backs up an existing manually installed Fish script before replacement', async () => {
    const o = await fixture();
    const path = join(o.home, '.config/fish/completions/spatius.fish');
    await mkdir(join(o.home, '.config/fish/completions'), { recursive: true });
    await writeFile(path, '# existing custom completions\n');
    await chmod(path, 0o600);
    const result = await installShellCompletions('fish', o);
    expect(await readFile(result.backups[0]!, 'utf8')).toBe(
      '# existing custom completions\n',
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it.each(['malformed', 'dangling-symlink', 'directory'])(
    'validates %s profiles before changing any files',
    async (kind) => {
      const o = await fixture();
      const profile = join(o.home, '.zshrc');
      if (kind === 'malformed')
        await writeFile(profile, '# >>> spatius completions >>>\nuser text\n');
      if (kind === 'dangling-symlink')
        await symlink(join(o.home, 'missing'), profile);
      if (kind === 'directory') await mkdir(profile);
      await expect(installShellCompletions('zsh', o)).rejects.toMatchObject({
        code: 'INSTALL_COMPLETIONS_FAILED',
      });
      expect(await readdir(o.home)).toEqual(['.zshrc']);
    },
  );
});
