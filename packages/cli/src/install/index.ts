import { AuthManager } from '../auth/index.js';
import { readConfig } from '../core/config.js';
import { CliError } from '../core/errors.js';
import { runProcess } from './process.js';
import { InstallServices } from './services.js';
import { createInstallerUI } from './ui.js';
import { runWizard } from './wizard.js';

interface InstallerOptions {
  version: string;
  json: boolean;
  signal: AbortSignal;
}
export function validateInstallerEnvironment(options: {
  json: boolean;
  nodeVersion: string;
  stdinTTY: boolean;
  stdoutTTY: boolean;
  ci?: string;
}): void {
  if (options.json)
    throw new CliError(
      'INVALID_ARGUMENT',
      'The interactive installer does not support --json.',
      {
        exitCode: 2,
        recovery:
          'Run spatius install in a terminal, or use npm, skills, spatius auth login, and spatius setup separately.',
      },
    );
  if (Number(options.nodeVersion.split('.')[0]) < 22)
    throw new CliError(
      'INSTALL_PREREQUISITE',
      'Spatius requires Node.js 22 or newer.',
      {
        recovery:
          'Install Node.js 22+ with npm and npx, then rerun the installer.',
      },
    );
  const ci =
    options.ci !== undefined &&
    !['', '0', 'false', 'no', 'off'].includes(options.ci.toLowerCase());
  if (!options.stdinTTY || !options.stdoutTTY || ci)
    throw new CliError(
      'INTERACTIVE_REQUIRED',
      'Spatius installation requires an interactive terminal outside CI.',
      {
        exitCode: 2,
        recovery:
          'Run spatius install in a local terminal. For scripts, use npm install -g @spatius/cli@beta and the skills, auth login, and setup commands separately.',
      },
    );
}

export async function runInstaller({
  version,
  json,
  signal,
}: InstallerOptions): Promise<void> {
  validateInstallerEnvironment({
    json,
    nodeVersion: process.versions.node,
    stdinTTY: process.stdin.isTTY === true,
    stdoutTTY: process.stdout.isTTY === true,
    ci: process.env.CI,
  });
  await runWizard({
    version,
    signal,
    ui: createInstallerUI(signal),
    services: new InstallServices({
      runner: runProcess,
      cwd: process.cwd(),
      signal,
    }),
    createAuth: () => new AuthManager({ ...readConfig(), signal }),
  });
}
