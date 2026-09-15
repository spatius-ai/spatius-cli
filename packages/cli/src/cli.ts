#!/usr/bin/env node
import { CommanderError } from 'commander';
import { AuthManager } from './auth/index.js';
import { Workflows } from './workflows/index.js';
import { buildProgram, type Context } from './commands.js';
import { readConfig } from './core/config.js';
import { asCliError, CliError } from './core/errors.js';
import pkg from '../package.json';
import { createNotifier } from './update/notifier.js';

const notifier = createNotifier({
  version: pkg.version,
  args: process.argv.slice(2),
});
const notice = notifier.notice ? { updateAvailable: notifier.notice } : {};
let emitted = false;

const controller = new AbortController();
const interrupt = () =>
  controller.abort(new DOMException('Interrupted', 'AbortError'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const progress = (event: unknown) =>
  process.stderr.write(
    `${JSON.stringify({ schemaVersion: 1, ...(typeof event === 'object' && event !== null ? event : { event }) })}\n`,
  );
const emit = (data: unknown) => {
  emitted = true;
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, ok: true, data, ...notice })}\n`,
  );
};
let context: Context | undefined;
let humanOutput = false;
const program = buildProgram(
  () => {
    if (!context) {
      const config = readConfig();
      const auth = new AuthManager(config);
      context = {
        auth,
        workflows: new Workflows({
          ...config,
          auth,
          signal: controller.signal,
          onProgress: progress,
        }),
        signal: controller.signal,
        progress,
      };
    }
    return context;
  },
  emit,
  pkg.version,
  {
    signal: controller.signal,
    onHumanOutput: () => {
      humanOutput = true;
    },
  },
);
program.configureOutput({ writeErr: () => undefined });
try {
  if (process.argv.length <= 2) program.outputHelp();
  else await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0)
    process.exitCode = 0;
  else {
    emitted = true;
    const e =
      error instanceof CommanderError
        ? new CliError('INVALID_ARGUMENT', error.message, {
            exitCode: 2,
            recovery: 'Run spatius --help or spatius schema.',
          })
        : asCliError(error);
    if (humanOutput)
      process.stderr.write(
        `${e.code === 'INTERRUPTED' ? 'Cancelled' : 'Error'} [${e.code}]: ${e.message}\n${e.options.recovery ? `Recovery: ${e.options.recovery}\n` : ''}`,
      );
    else
      process.stderr.write(
        `${JSON.stringify({ schemaVersion: 1, ok: false, error: { code: e.code, message: e.message, retryable: e.options.retryable ?? false, recovery: e.options.recovery, details: e.options.details }, ...notice })}\n`,
      );
    process.exitCode = e.options.exitCode ?? 1;
  }
} finally {
  if (!emitted && notifier.notice)
    process.stderr.write(`${notifier.notice.message}\n`);
  notifier.finish();
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
