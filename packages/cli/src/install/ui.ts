// Prompt conventions adapted from create-spatius-app (MIT, spatialwalk 2026).
import { confirm, intro, note, outro, select, spinner } from '@clack/prompts';
import { CliError } from '../core/errors.js';
import { Presence } from './presence.js';
import { createTerminalTheme } from './theme.js';
import { checkInterrupted } from './process.js';
import type { InstallerUI } from './wizard.js';
import type { CompletionShell } from '../completions.js';

export function createInstallerUI(signal: AbortSignal): InstallerUI {
  // Node's styleText (used by Clack) treats an empty NO_COLOR differently from our theme.
  // Normalize it during this UI session, including the delegated skills child.
  const noColor = process.env.NO_COLOR;
  const forceColor = process.env.FORCE_COLOR;
  if ('NO_COLOR' in process.env) {
    process.env.NO_COLOR = '1';
    process.env.FORCE_COLOR = '0';
  }
  const theme = createTerminalTheme();
  const presence = new Presence({ interactive: true, theme });
  const raw = process.stdin.isRaw ?? false;
  const flowing = process.stdin.readableFlowing === true;
  let closed = false;
  return {
    async welcome(version) {
      await presence.welcome();
      checkInterrupted(signal);
      intro(
        `${theme.accent('Spatius CLI installer')} ${theme.highlight(`v${version}`)}`,
      );
    },
    async confirm(message) {
      checkInterrupted(signal);
      const answer = await confirm({
        message,
        initialValue: true,
        active: 'Yes',
        inactive: 'No',
        signal,
      });
      if (typeof answer === 'symbol')
        throw new CliError(
          'INTERRUPTED',
          'Installation was cancelled. Completed steps are retained.',
          { exitCode: 130 },
        );
      checkInterrupted(signal);
      return answer;
    },
    async selectCompletionShell(detected) {
      checkInterrupted(signal);
      const answer = await select<CompletionShell | 'skip'>({
        message: 'Set up shell completions?',
        initialValue: detected ?? 'skip',
        options: [
          {
            value: 'bash',
            label: 'Bash',
            hint: 'save completions and update Bash startup files',
          },
          {
            value: 'zsh',
            label: 'Zsh',
            hint: 'save completions and update .zshrc',
          },
          {
            value: 'fish',
            label: 'Fish',
            hint: 'save an automatically loaded completion file',
          },
          {
            value: 'skip',
            label: 'Skip',
            hint: 'leave shell configuration unchanged',
          },
        ],
        signal,
      });
      if (typeof answer === 'symbol')
        throw new CliError(
          'INTERRUPTED',
          'Installation was cancelled. Completed steps are retained.',
          { exitCode: 130 },
        );
      checkInterrupted(signal);
      return answer === 'skip' ? undefined : answer;
    },
    note(message, title = 'Setup') {
      note(message, theme.accent(title));
    },
    async task(message, work) {
      checkInterrupted(signal);
      const progress =
        presence.animated && message === 'Installing Spatius CLI'
          ? presence
          : spinner({ signal });
      progress.start(message);
      try {
        const result = await work();
        checkInterrupted(signal);
        progress.stop(`${message} — done`);
        return result;
      } catch (error) {
        progress.stop(`${message} — stopped`);
        throw error;
      }
    },
    async handoff(work) {
      presence.stop();
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      try {
        await work();
      } finally {
        process.stdin.setRawMode?.(raw);
        if (flowing) process.stdin.resume();
        process.stdout.write('\u001b[?25h');
      }
    },
    finish(message) {
      outro(theme.highlight(message));
    },
    close() {
      if (closed) return;
      closed = true;
      presence.stop();
      process.stdin.setRawMode?.(raw);
      if (!flowing) process.stdin.pause();
      else process.stdin.resume();
      process.stdout.write('\u001b[?25h');
      if (noColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = noColor;
      if (forceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = forceColor;
    },
  };
}
