import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
  rm,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  completionScript,
  completionShells,
  type CompletionShell,
} from '../completions.js';
import { CliError } from '../core/errors.js';
import { checkInterrupted, type ProcessRunner } from './process.js';

interface ShellOptions {
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  runner: ProcessRunner;
  cwd: string;
  signal: AbortSignal;
  parentPid: number;
}

function shellName(command: string): CompletionShell | undefined {
  const name = basename(command).replace(/^-/, '');
  return completionShells.find((shell) => shell === name);
}

/** npm exec inserts node and sh processes between this CLI and the user's shell. */
export async function detectCompletionShell(options: ShellOptions) {
  if (options.platform === 'win32') return { supported: false };
  let pid = options.parentPid;
  const seen = new Set<number>();
  for (let depth = 0; depth < 12 && pid > 1 && !seen.has(pid); depth++) {
    checkInterrupted(options.signal);
    seen.add(pid);
    try {
      // Only inspect process identity, never arguments or environment (which may contain secrets).
      const result = await options.runner({
        command: 'ps',
        args: ['-p', String(pid), '-o', 'ppid=', '-o', 'comm='],
        cwd: options.cwd,
        signal: options.signal,
        timeoutMs: 1000,
      });
      const match =
        result.code === 0 && result.stdout.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) break;
      const shell = shellName(match[2]!);
      if (shell) return { supported: true, shell, source: 'launching process' };
      pid = Number(match[1]);
    } catch {
      checkInterrupted(options.signal);
      break;
    }
  }
  const shell = shellName(options.environment.SHELL ?? '');
  return {
    supported: true,
    shell,
    source: shell ? 'login shell (SHELL)' : undefined,
  };
}

const start = '# >>> spatius completions >>>';
const end = '# <<< spatius completions <<<';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function managedContent(current: string, body: string): string {
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const block = [start, body.trimEnd(), end]
    .join('\n')
    .replaceAll('\n', newline);
  const from = current.indexOf(start);
  const to = current.indexOf(end);
  if (from === -1 && to === -1)
    return (
      current +
      (current && !current.endsWith('\n') ? newline : '') +
      block +
      newline
    );
  if (
    from === -1 ||
    to < from ||
    current.indexOf(start, from + start.length) !== -1 ||
    current.indexOf(end, to + end.length) !== -1
  )
    throw new Error(
      'The existing Spatius completion markers are incomplete or duplicated.',
    );
  return current.slice(0, from) + block + current.slice(to + end.length);
}

async function readTarget(path: string) {
  let target = path;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) target = await realpath(path);
    const file = await stat(target);
    if (!file.isFile()) throw new Error(`Expected a regular file at ${path}.`);
    return {
      target,
      content: await readFile(target, 'utf8'),
      mode: file.mode & 0o777,
      exists: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Do not replace a dangling dotfile symlink.
    const link = await lstat(path).catch(() => undefined);
    if (link) throw error;
    return { target, content: '', mode: 0o644, exists: false };
  }
}

export interface CompletionInstallation {
  shell: CompletionShell;
  files: string[];
  backups: string[];
  activation: string;
}

export async function installShellCompletions(
  shell: CompletionShell,
  options: {
    home: string;
    environment: NodeJS.ProcessEnv;
    cwd: string;
    signal: AbortSignal;
  },
): Promise<CompletionInstallation> {
  const { environment, home, signal } = options;
  const xdg = (name: string, fallback: string) => {
    const value = environment[name];
    return value && isAbsolute(value) ? value : join(home, fallback);
  };
  const script =
    shell === 'fish'
      ? join(
          xdg('XDG_CONFIG_HOME', '.config'),
          'fish',
          'completions',
          'spatius.fish',
        )
      : join(
          xdg('XDG_DATA_HOME', '.local/share'),
          'spatius',
          'completions',
          `spatius.${shell}`,
        );
  const files: { path: string; body: string; managed: boolean }[] = [
    { path: script, body: completionScript(shell), managed: false },
  ];
  const backups: string[] = [];
  try {
    checkInterrupted(signal);
    if (shell === 'bash') {
      const body = `if [ -n "\${BASH_VERSION:-}" ] && [ -r ${quote(script)} ]; then\n  case $- in *i*) . ${quote(script)} ;; esac\nfi`;
      files.push({ path: join(home, '.bashrc'), body, managed: true });
      // Bash reads the first existing login profile. Do not shadow .profile by
      // unconditionally creating .bash_profile (a common Linux setup regression).
      let profile = join(home, '.bash_profile');
      for (const name of ['.bash_profile', '.bash_login', '.profile']) {
        const candidate = join(home, name);
        if ((await readTarget(candidate)).exists) {
          profile = candidate;
          break;
        }
      }
      files.push({ path: profile, body, managed: true });
    } else if (shell === 'zsh') {
      // Keep compinit's security audit, but exclude insecure directories instead
      // of prompting (which aborts when the shell has no controlling terminal).
      const directory = environment.ZDOTDIR
        ? resolve(options.cwd, environment.ZDOTDIR)
        : home;
      const body = `if [[ -o interactive && -r ${quote(script)} ]]; then\n  if (( ! $+functions[compdef] )); then\n    autoload -Uz compinit\n    compinit -i\n  fi\n  source ${quote(script)}\nfi`;
      files.push({ path: join(directory, '.zshrc'), body, managed: true });
    }
    // Read and validate every target before writing any of them.
    const changes = await Promise.all(
      files.map(async (file) => {
        const prior = await readTarget(file.path);
        return {
          ...file,
          ...prior,
          next: file.managed
            ? managedContent(prior.content, file.body)
            : file.body,
        };
      }),
    );
    for (const change of changes) {
      checkInterrupted(signal);
      if (change.exists && change.next === change.content) continue;
      await mkdir(dirname(change.target), { recursive: true });
      const fresh = await readTarget(change.path);
      if (
        fresh.target !== change.target ||
        fresh.content !== change.content ||
        fresh.exists !== change.exists
      )
        throw new Error(
          `File changed during installation: ${change.path}. Rerun the installer.`,
        );
      if (change.exists) {
        const backup = `${change.target}.spatius-backup-${randomUUID()}`;
        await copyFile(change.target, backup, constants.COPYFILE_EXCL);
        backups.push(backup);
      }
      const temporary = `${change.target}.spatius-${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, change.next, {
          flag: 'wx',
          mode: change.mode,
        });
        if (change.exists) await chmod(temporary, change.mode);
        await rename(temporary, change.target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    const sourcePath =
      shell === 'fish'
        ? "'" + script.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'"
        : quote(script);
    const initialize =
      shell === 'zsh'
        ? 'autoload -Uz compinit; (( $+functions[compdef] )) || compinit -i\n'
        : '';
    return {
      shell,
      files: files.map((file) => file.path),
      backups,
      activation: `Open a new terminal, or run:\n${initialize}source ${sourcePath}`,
    };
  } catch (error) {
    checkInterrupted(signal);
    throw new CliError(
      'INSTALL_COMPLETIONS_FAILED',
      'Shell completion setup did not finish. Completed file changes are retained.',
      {
        recovery: `Check write access and Spatius completion markers in ${files.map((file) => file.path).join(', ')}. Rerun the installer after correcting the problem.${backups.length ? ` Original files were backed up at: ${backups.join(', ')}.` : ''}`,
        details: {
          reason:
            error instanceof Error ? error.message : 'File update failed.',
        },
      },
    );
  }
}
