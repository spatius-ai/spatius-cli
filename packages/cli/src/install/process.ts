import spawn from 'cross-spawn';
import { CliError } from '../core/errors.js';

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  inherit?: boolean;
  timeoutMs?: number;
}
export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export function checkInterrupted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new CliError(
      'INTERRUPTED',
      'Installation was interrupted. Completed steps are retained.',
      { exitCode: 130 },
    );
}

// cross-spawn resolves and escapes Windows npm/npx .cmd shims. Never concatenate a shell command.
export const runProcess: ProcessRunner = async (request) => {
  checkInterrupted(request.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      stdio: request.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Captured package operations get a process group so cancellation reaches npm's children.
      detached: !request.inherit && process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (force = false) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn(
          'taskkill',
          ['/pid', String(child.pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true },
        );
        killer.on('error', () => child.kill());
      } else if (!request.inherit) {
        try {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          /* Already exited. */
        }
      } else child.kill(force ? 'SIGKILL' : 'SIGTERM');
    };
    const abort = () => {
      terminate();
      forceTimer ??= setTimeout(() => terminate(true), 2000);
      forceTimer.unref();
    };
    const timeout =
      request.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            abort();
          }, request.timeoutMs);
    const cleanup = () => {
      request.signal.removeEventListener('abort', abort);
      if (timeout) clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
    };
    // Keep bounded diagnostics in memory; never print arbitrary package-manager output or config.
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-65536);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        new CliError(
          'INSTALL_PROCESS_UNAVAILABLE',
          `Could not start ${request.command === process.execPath ? 'Node.js' : request.command} (${error.code ?? 'spawn error'}).`,
          {
            recovery:
              'Check that Node.js 22+, npm, and npx are available on PATH, then rerun the installer.',
          },
        ),
      );
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (request.signal.aborted || signal === 'SIGINT') {
        reject(
          new CliError(
            'INTERRUPTED',
            'Installation was interrupted. Completed steps are retained.',
            { exitCode: 130 },
          ),
        );
      } else if (timedOut) {
        reject(
          new CliError(
            'INSTALL_PROCESS_TIMEOUT',
            'The package-manager check timed out.',
            {
              recovery:
                'Check npm and your registry connection, then rerun the installer.',
            },
          ),
        );
      } else resolve({ code: code ?? 1, stdout, stderr });
    });
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
  });
};
