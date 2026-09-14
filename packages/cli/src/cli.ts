#!/usr/bin/env node
import { CommanderError } from 'commander';
import { AuthManager } from './auth/index.js';
import { Workflows } from './workflows/index.js';
import { buildProgram, type Context } from './commands.js';
import { readConfig } from './core/config.js';
import { asCliError, CliError } from './core/errors.js';
import pkg from '../package.json';

const controller = new AbortController();
const interrupt = () =>
  controller.abort(new DOMException('Interrupted', 'AbortError'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const progress = (event: unknown) =>
  process.stderr.write(
    `${JSON.stringify({ schemaVersion: 1, ...(typeof event === 'object' && event !== null ? event : { event }) })}\n`,
  );
const emit = (data: unknown) =>
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, ok: true, data })}\n`,
  );
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
        `${JSON.stringify({ schemaVersion: 1, ok: false, error: { code: e.code, message: e.message, retryable: e.options.retryable ?? false, recovery: e.options.recovery, details: e.options.details } })}\n`,
      );
    process.exitCode = e.options.exitCode ?? 1;
  }
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
