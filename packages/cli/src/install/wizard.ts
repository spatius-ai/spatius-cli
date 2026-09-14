import type { AuthManager } from '../auth/index.js';
import { checkInterrupted } from './process.js';
import type { InstallServices } from './services.js';

export interface InstallerUI {
  welcome(version: string): Promise<void>;
  confirm(message: string): Promise<boolean>;
  note(message: string, title?: string): void;
  task<T>(message: string, work: () => Promise<T>): Promise<T>;
  handoff(work: () => Promise<void>): Promise<void>;
  finish(message: string): void;
  close(): void;
}
export interface WizardOptions {
  version: string;
  signal: AbortSignal;
  ui: InstallerUI;
  services: Pick<
    InstallServices,
    | 'prerequisites'
    | 'inspectGlobal'
    | 'installCli'
    | 'existingCliAvailable'
    | 'installSkills'
  >;
  createAuth: () => Pick<AuthManager, 'status' | 'login' | 'setup'>;
}

export async function runWizard({
  version,
  signal,
  ui,
  services,
  createAuth,
}: WizardOptions): Promise<void> {
  let cli = 'Skipped';
  let skills = 'Skipped';
  let studio = 'Not configured during this run';
  let available = false;
  const summary = () => `CLI: ${cli}\nSkills: ${skills}\nStudio: ${studio}`;
  try {
    checkInterrupted(signal);
    await services.prerequisites();
    await ui.welcome(version);
    checkInterrupted(signal);
    const shouldInstallCli = await ui.confirm('Install Spatius CLI globally?');
    const shouldInstallSkills = await ui.confirm(
      'Install Spatius agent skills?',
    );
    checkInterrupted(signal);
    if (shouldInstallCli) {
      cli = 'Not completed';
      const global = await ui.task('Checking the global CLI', () =>
        services.inspectGlobal(),
      );
      if (global.version && global.version !== version)
        ui.note(
          `Replace @spatius/cli v${global.version} with v${version}.`,
          'CLI version',
        );
      const installed = await ui.task(
        global.version === version
          ? 'Verifying the global CLI'
          : 'Installing Spatius CLI',
        () => services.installCli(version, global),
      );
      cli = `${installed.reused ? 'Reused' : 'Installed'} v${installed.version}`;
      available = installed.available;
      if (installed.warning) {
        ui.note(installed.warning, 'PATH');
        cli += ' (PATH needs attention)';
      }
    } else available = await services.existingCliAvailable();
    checkInterrupted(signal);
    if (shouldInstallSkills) {
      skills = 'Not completed; see installer results above';
      ui.note(
        'Choose your agents, installation scope, and installation method in the skills installer.',
        'Agent skills',
      );
      await ui.handoff(() => services.installSkills());
      skills = 'see installer results above';
    }
    checkInterrupted(signal);
    ui.note(
      'Studio setup configures an app and API key for this CLI. Existing login and app credentials are reused when possible.',
      'Spatius Studio',
    );
    if (await ui.confirm('Log in and set up Spatius Studio now?')) {
      checkInterrupted(signal);
      studio = 'Not completed';
      const auth = createAuth();
      const status = await ui.task('Checking Studio login', () =>
        auth.status(),
      );
      checkInterrupted(signal);
      if (!status.authenticated) {
        // The URL is deliberately shown for browser-launch failures; no tokens or keys are printed.
        await auth.login({
          signal,
          onAuthorize: (url) =>
            ui.note(
              `Approve login in your local browser:\n${url}`,
              'Browser approval',
            ),
        });
      }
      checkInterrupted(signal);
      const result = await ui.task('Setting up the Studio app', () =>
        auth.setup(),
      );
      studio = `Ready — account ${result.userId}, app ${result.appId}`;
    } else {
      const command = available ? 'spatius' : `npx @spatius/cli@${version}`;
      ui.note(`${command} auth login\n${command} setup`, 'Set up Studio later');
    }
    checkInterrupted(signal);
    ui.note(summary(), 'Installation summary');
    ui.finish('Spatius installation finished.');
  } catch (error) {
    ui.note(summary(), 'Progress retained');
    checkInterrupted(signal);
    throw error;
  } finally {
    ui.close();
  }
}
