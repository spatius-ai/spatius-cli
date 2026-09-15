import { describe, expect, it, vi } from 'vitest';
import { runWizard } from '../src/install/wizard.js';
import { CliError } from '../src/core/errors.js';
import { validateInstallerEnvironment } from '../src/install/index.js';
import { buildProgram, commandSchema } from '../src/commands.js';
import type { CompletionShell } from '../src/completions.js';

function harness(answers = [true, true, true], authenticated = true) {
  const controller = new AbortController();
  const ui = {
    welcome: vi.fn(async () => {}),
    confirm: vi.fn(async () => answers.shift() ?? false),
    selectCompletionShell: vi.fn(
      async (): Promise<CompletionShell | undefined> => undefined,
    ),
    note: vi.fn(),
    task: async <T>(_: string, work: () => Promise<T>) => work(),
    handoff: vi.fn(async (work: () => Promise<void>) => work()),
    finish: vi.fn(),
    close: vi.fn(),
  };
  const services = {
    prerequisites: vi.fn(async () => {}),
    inspectGlobal: vi.fn(async () => ({
      version: '0.0.9',
      entry: '/global/cli.js',
      binary: '/global/bin/spatius',
      binDirectory: '/global/bin',
    })),
    installCli: vi.fn(async () => ({
      version: '0.1.0-beta.0',
      reused: false,
      available: true,
    })),
    existingCliAvailable: vi.fn(async () => false),
    installSkills: vi.fn(async () => {}),
    detectCompletionShell: vi.fn(async () => ({
      supported: true,
      shell: 'zsh' as CompletionShell,
      source: 'launching process',
    })),
    installCompletions: vi.fn(async (shell: CompletionShell) => ({
      shell,
      files: ['/home/user/.zshrc'],
      backups: [],
      activation: 'Open a new terminal.',
    })),
  };
  const auth = {
    status: vi.fn(async () => ({ authenticated })),
    login: vi.fn(async (options: { onAuthorize?: (url: string) => void }) => {
      options.onAuthorize?.('https://app.spatius.ai/cli/auth/approval');
      return { authenticated: true };
    }),
    setup: vi.fn(async () => ({
      userId: 'test-user',
      appId: 'test-app',
      reused: true,
    })),
  };
  const createAuth = vi.fn(() => auth);
  const run = () =>
    runWizard({
      version: '0.1.0-beta.0',
      signal: controller.signal,
      ui,
      services,
      createAuth,
    });
  return { controller, ui, services, auth, createAuth, run };
}

describe('installer orchestration', () => {
  it('offers the launching shell after installing the persistent CLI and permits an override', async () => {
    const h = harness();
    h.ui.selectCompletionShell.mockResolvedValue('fish');
    await h.run();
    expect(h.ui.selectCompletionShell).toHaveBeenCalledWith('zsh');
    expect(h.services.installCompletions).toHaveBeenCalledWith('fish');
    expect(
      h.services.installCompletions.mock.invocationCallOrder[0],
    ).toBeGreaterThan(h.services.installCli.mock.invocationCallOrder[0]!);
    expect(h.ui.note).toHaveBeenCalledWith(
      expect.stringContaining('Completions: fish: Installed'),
      'Installation summary',
    );
  });
  it('can configure completions for an existing persistent CLI', async () => {
    const h = harness([false, false, false]);
    h.services.existingCliAvailable.mockResolvedValue(true);
    h.ui.selectCompletionShell.mockResolvedValue('bash');
    await h.run();
    expect(h.services.installCli).not.toHaveBeenCalled();
    expect(h.services.installCompletions).toHaveBeenCalledWith('bash');
  });
  it('does not edit shell configuration when skipped', async () => {
    const h = harness();
    await h.run();
    expect(h.services.installCompletions).not.toHaveBeenCalled();
  });
  it('does not offer unusable completions when npx is the only CLI', async () => {
    const h = harness([false, false, false]);
    await h.run();
    expect(h.services.detectCompletionShell).not.toHaveBeenCalled();
    expect(h.ui.selectCompletionShell).not.toHaveBeenCalled();
    expect(h.ui.note).toHaveBeenCalledWith(
      expect.stringContaining('spatius needs to be on PATH'),
      'Installation summary',
    );
  });
  it('retains CLI progress after a completion installation failure', async () => {
    const h = harness();
    h.ui.selectCompletionShell.mockResolvedValue('zsh');
    h.services.installCompletions.mockRejectedValue(
      new CliError('INSTALL_COMPLETIONS_FAILED', 'Check profile permissions.'),
    );
    await expect(h.run()).rejects.toMatchObject({
      code: 'INSTALL_COMPLETIONS_FAILED',
    });
    expect(h.ui.note).toHaveBeenCalledWith(
      expect.stringContaining('Completions: zsh: Not completed'),
      'Progress retained',
    );
    expect(h.ui.close).toHaveBeenCalled();
  });
  it('stops cancellation at shell selection before editing files', async () => {
    const h = harness();
    h.ui.selectCompletionShell.mockImplementation(async () => {
      h.controller.abort();
      return 'zsh';
    });
    await expect(h.run()).rejects.toMatchObject({ code: 'INTERRUPTED' });
    expect(h.services.installCompletions).not.toHaveBeenCalled();
  });
  it.each(
    [false, true].flatMap((cli) =>
      [false, true].flatMap((skills) =>
        [false, true].map((studio) => [cli, skills, studio]),
      ),
    ),
  )('handles CLI=%s skills=%s Studio=%s', async (cli, skills, studio) => {
    const h = harness([cli!, skills!, studio!]);
    await h.run();
    expect(h.services.installCli).toHaveBeenCalledTimes(cli ? 1 : 0);
    expect(h.services.installSkills).toHaveBeenCalledTimes(skills ? 1 : 0);
    expect(h.createAuth).toHaveBeenCalledTimes(studio ? 1 : 0);
    expect(h.auth.login).not.toHaveBeenCalled();
    expect(h.auth.setup).toHaveBeenCalledTimes(studio ? 1 : 0);
    expect(h.ui.close).toHaveBeenCalledTimes(1);
    if (skills)
      expect(h.ui.note).toHaveBeenCalledWith(
        expect.stringContaining('Skills: see installer results above'),
        'Installation summary',
      );
    if (!studio)
      expect(h.ui.note).toHaveBeenCalledWith(
        expect.stringContaining(
          cli
            ? 'spatius auth login'
            : 'npx @spatius/cli@0.1.0-beta.0 auth login',
        ),
        'Set up Studio later',
      );
  });
  it('shows the replacement versions before installation', async () => {
    const h = harness();
    await h.run();
    const call = h.ui.note.mock.calls.findIndex((c) => c[1] === 'CLI version');
    expect(h.ui.note.mock.calls[call]?.[0]).toContain(
      'v0.0.9 with v0.1.0-beta.0',
    );
    expect(h.ui.note.mock.invocationCallOrder[call]).toBeLessThan(
      h.services.installCli.mock.invocationCallOrder[0]!,
    );
  });
  it('logs in only when necessary and shows the approval URL', async () => {
    const h = harness([false, false, true], false);
    await h.run();
    expect(h.auth.login).toHaveBeenCalledWith(
      expect.objectContaining({ signal: h.controller.signal }),
    );
    expect(h.ui.note).toHaveBeenCalledWith(
      expect.stringContaining('https://app.spatius.ai/cli/auth/approval'),
      'Browser approval',
    );
    expect(h.auth.setup).toHaveBeenCalledWith();
  });
  it.each(['AUTH_DECLINED', 'AUTH_TIMEOUT', 'BOOTSTRAP_UNCERTAIN'])(
    'retains progress after %s without retrying',
    async (code) => {
      const h = harness([true, true, true], false);
      if (code === 'BOOTSTRAP_UNCERTAIN')
        h.auth.setup.mockRejectedValue(
          new CliError(code, 'Reconcile before retrying.'),
        );
      else
        h.auth.login.mockRejectedValue(
          new CliError(code, 'Approval did not complete.'),
        );
      await expect(h.run()).rejects.toMatchObject({ code });
      expect(h.ui.note).toHaveBeenCalledWith(
        expect.stringContaining('Installed v0.1.0-beta.0'),
        'Progress retained',
      );
      expect(h.ui.finish).not.toHaveBeenCalled();
      expect(h.auth.login).toHaveBeenCalledTimes(1);
      expect(h.auth.setup).toHaveBeenCalledTimes(
        code === 'BOOTSTRAP_UNCERTAIN' ? 1 : 0,
      );
      expect(h.ui.close).toHaveBeenCalledTimes(1);
    },
  );
  it('stops before skills and Studio after npm fails', async () => {
    const h = harness();
    h.services.installCli.mockRejectedValue(
      new CliError('INSTALL_FAILED', 'npm failed'),
    );
    await expect(h.run()).rejects.toMatchObject({ code: 'INSTALL_FAILED' });
    expect(h.services.installSkills).not.toHaveBeenCalled();
    expect(h.createAuth).not.toHaveBeenCalled();
    expect(h.ui.close).toHaveBeenCalled();
  });
  it('does not proceed to Studio after skills fail', async () => {
    const h = harness();
    h.services.installSkills.mockRejectedValue(
      new CliError('INSTALL_FAILED', 'skills failed'),
    );
    await expect(h.run()).rejects.toMatchObject({ code: 'INSTALL_FAILED' });
    expect(h.createAuth).not.toHaveBeenCalled();
    expect(h.ui.close).toHaveBeenCalled();
  });
  it('checks cancellation between stages and preserves completed steps', async () => {
    const h = harness();
    h.services.installSkills.mockImplementation(async () => {
      h.controller.abort();
    });
    await expect(h.run()).rejects.toMatchObject({
      code: 'INTERRUPTED',
      options: { exitCode: 130 },
    });
    expect(h.createAuth).not.toHaveBeenCalled();
    expect(h.ui.close).toHaveBeenCalledTimes(1);
  });
  it('does not print unexpected credential fields from auth results', async () => {
    const h = harness();
    h.auth.setup.mockResolvedValue({
      userId: 'test-user',
      appId: 'test-app',
      reused: true,
      apiKey: 'DO_NOT_LOG_TEST_SECRET',
    } as Awaited<ReturnType<typeof h.auth.setup>>);
    await h.run();
    expect(JSON.stringify(h.ui.note.mock.calls)).not.toContain(
      'DO_NOT_LOG_TEST_SECRET',
    );
  });
});

describe('installer interaction contract', () => {
  it.each([
    { json: true },
    { stdinTTY: false },
    { stdoutTTY: false },
    { ci: 'true' },
    { nodeVersion: '20.0.0' },
  ])('rejects unsupported environment before running work: %j', (override) => {
    expect(() =>
      validateInstallerEnvironment({
        json: false,
        nodeVersion: '22.0.0',
        stdinTTY: true,
        stdoutTTY: true,
        ...override,
      }),
    ).toThrow(CliError);
  });
  it.each(['', '0', 'false', 'no', 'off'])('allows inactive CI=%s', (ci) => {
    expect(() =>
      validateInstallerEnvironment({
        json: false,
        nodeVersion: '22.0.0',
        stdinTTY: true,
        stdoutTTY: true,
        ci,
      }),
    ).not.toThrow();
  });
  it('discovers human output without initializing credentials', async () => {
    const context = vi.fn(() => {
      throw new Error('Must not initialize');
    });
    const emit = vi.fn();
    await buildProgram(context, emit, 'test').parseAsync([
      'node',
      'spatius',
      'schema',
      'install',
    ]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: [
          expect.objectContaining({
            path: 'install',
            interactive: true,
            outputMode: 'human',
            supportsJson: false,
          }),
        ],
      }),
    );
    expect(context).not.toHaveBeenCalled();
    expect(commandSchema('auth login').commands[0]).not.toHaveProperty(
      'outputMode',
    );
  });
  it('rejects install --json before context creation or success emission', async () => {
    const context = vi.fn(() => {
      throw new Error('Must not initialize');
    });
    const emit = vi.fn();
    await expect(
      buildProgram(context, emit, 'test').parseAsync([
        'node',
        'spatius',
        'install',
        '--json',
      ]),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      options: { exitCode: 2 },
    });
    expect(context).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
