import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { CliError } from '../core/errors.js';
import {
  checkInterrupted,
  type ProcessResult,
  type ProcessRunner,
} from './process.js';

import { bundledSkillsDirectory, skillNames } from './assets.js';
export { bundledSkillsDirectory, skillNames } from './assets.js';
export interface GlobalInstallation {
  version?: string;
  entry: string;
  binary: string;
  binDirectory: string;
}
export interface CliInstallation {
  version: string;
  reused: boolean;
  available: boolean;
  warning?: string;
}
interface Options {
  runner: ProcessRunner;
  cwd: string;
  signal: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  skillsDirectory?: string;
}

export class InstallServices {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  constructor(private readonly options: Options) {
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
  }
  private run(
    command: string,
    args: string[],
    inherit = false,
    timeoutMs?: number,
  ) {
    checkInterrupted(this.options.signal);
    return this.options.runner({
      command,
      args,
      inherit,
      timeoutMs,
      cwd: this.options.cwd,
      signal: this.options.signal,
    });
  }
  async prerequisites(): Promise<void> {
    for (const command of ['npm', 'npx']) {
      const result = await this.run(command, ['--version'], false, 15000);
      if (result.code !== 0)
        throw new CliError(
          'INSTALL_PREREQUISITE',
          `${command} is not working.`,
          {
            recovery:
              'Install Node.js 22+ with npm and npx, then rerun the installer.',
          },
        );
    }
  }
  async inspectGlobal(): Promise<GlobalInstallation> {
    const root = await this.run('npm', ['root', '--global'], false, 15000);
    const prefix = await this.run('npm', ['prefix', '--global'], false, 15000);
    if (
      root.code !== 0 ||
      prefix.code !== 0 ||
      !isAbsolute(root.stdout.trim()) ||
      !isAbsolute(prefix.stdout.trim())
    )
      throw new CliError(
        'INSTALL_PREFIX_UNAVAILABLE',
        'Could not locate the npm global installation.',
        {
          recovery:
            'Check npm root --global and npm prefix --global, then rerun the installer.',
        },
      );
    const directory = join(root.stdout.trim(), '@spatius', 'cli');
    const binDirectory =
      this.platform === 'win32'
        ? prefix.stdout.trim()
        : join(prefix.stdout.trim(), 'bin');
    let version: string | undefined;
    try {
      const metadata = JSON.parse(
        await readFile(join(directory, 'package.json'), 'utf8'),
      );
      if (
        metadata.name === '@spatius/cli' &&
        typeof metadata.version === 'string'
      )
        version = metadata.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new CliError(
          'INSTALL_METADATA_INVALID',
          'The existing global CLI package metadata could not be read.',
          {
            recovery:
              'Repair the npm global @spatius/cli installation, then rerun the installer.',
          },
        );
    }
    return {
      version,
      entry: join(directory, 'dist', 'cli.js'),
      binDirectory,
      binary: join(
        binDirectory,
        this.platform === 'win32' ? 'spatius.cmd' : 'spatius',
      ),
    };
  }
  async installCli(
    version: string,
    global: GlobalInstallation,
  ): Promise<CliInstallation> {
    const reused = global.version === version;
    if (!reused) {
      const result = await this.run('npm', [
        'install',
        '--global',
        `@spatius/cli@${version}`,
      ]);
      if (result.code !== 0) this.packageFailure('CLI', result);
    }
    try {
      await access(global.binary);
      await access(global.entry);
    } catch {
      throw new CliError(
        'INSTALL_VERIFICATION_FAILED',
        `The installed CLI executable is missing at ${global.binary}.`,
        { recovery: 'Check npm global bin links and rerun the installer.' },
      );
    }
    const verified = await this.run(global.binary, ['--version'], false, 15000);
    if (verified.code !== 0 || verified.stdout.trim() !== version)
      throw new CliError(
        'INSTALL_VERIFICATION_FAILED',
        `The global CLI did not report the expected version ${version}.`,
        {
          recovery:
            'Check the npm global installation and rerun the installer.',
        },
      );
    const first = await this.findOnPath();
    const available =
      first !== undefined && (await this.sameFile(first, global.binary));
    return {
      version,
      reused,
      available,
      ...(!available
        ? {
            warning: first
              ? `Another executable takes precedence: ${first}. Put ${global.binDirectory} earlier on PATH, then reopen your terminal. Expected executable: ${global.binary}.`
              : `Spatius is installed at ${global.binary}, but its bin directory is missing from PATH. Add ${global.binDirectory} to PATH, then reopen your terminal.`,
          }
        : {}),
    };
  }
  async existingCliAvailable(): Promise<boolean> {
    return (await this.findOnPath()) !== undefined;
  }
  private async findOnPath(): Promise<string | undefined> {
    const path = this.environment.PATH ?? this.environment.Path ?? '';
    const extensions =
      this.platform === 'win32'
        ? (this.environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
        : [''];
    for (const directory of path.split(
      this.platform === 'win32' ? ';' : delimiter,
    )) {
      // npm exec/npx prepends its temporary launcher; it is not the user's persistent PATH.
      if (
        /[/\\]_npx[/\\][^/\\]+[/\\]node_modules[/\\]\.bin[/\\]?$/.test(
          directory,
        )
      )
        continue;
      for (const extension of extensions) {
        const candidate = resolve(
          this.options.cwd,
          directory,
          `spatius${extension.toLowerCase()}`,
        );
        try {
          await access(
            candidate,
            this.platform === 'win32' ? constants.F_OK : constants.X_OK,
          );
          return candidate;
        } catch {
          /* Continue PATH lookup. */
        }
      }
    }
    return undefined;
  }
  private async sameFile(a: string, b: string) {
    try {
      return (await realpath(a)) === (await realpath(b));
    } catch {
      return false;
    }
  }
  async installSkills(): Promise<void> {
    const source = this.options.skillsDirectory ?? bundledSkillsDirectory();
    for (const skill of skillNames) {
      try {
        await access(join(source, skill, 'SKILL.md'));
      } catch {
        throw new CliError(
          'INSTALL_SKILLS_MISSING',
          'This CLI package is missing its bundled Spatius skills.',
          {
            recovery:
              'Rerun npx with a published Spatius CLI version containing the bundled skills.',
          },
        );
      }
    }
    const result = await this.run(
      'npx',
      ['--yes', 'skills', 'add', source, '--skill', ...skillNames],
      true,
    );
    if (result.code === 130)
      throw new CliError(
        'INTERRUPTED',
        'Skills installation was interrupted.',
        { exitCode: 130 },
      );
    if (result.code !== 0) this.packageFailure('Skills', result);
  }
  private packageFailure(component: string, result: ProcessResult): never {
    const permissions = /\b(EACCES|EPERM)\b/.test(result.stderr);
    throw new CliError(
      'INSTALL_FAILED',
      `${component} installation failed (exit ${result.code})${permissions ? ' because npm could not write to its installation or cache directory' : ''}.`,
      {
        recovery: permissions
          ? 'Use an npm prefix/cache owned by your user or a Node version manager, then rerun the installer and skip completed steps.'
          : 'Check the package registry connection and package-manager diagnostics, then rerun the installer and skip completed steps.',
      },
    );
  }
}
