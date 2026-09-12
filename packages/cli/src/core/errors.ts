export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public options: {
      retryable?: boolean;
      recovery?: string;
      details?: unknown;
      exitCode?: number;
      status?: number;
      retryAfter?: number;
    } = {},
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error && error.name === 'AbortError')
    return new CliError('INTERRUPTED', 'Operation interrupted.', {
      exitCode: 130,
    });
  return new CliError(
    'INTERNAL_ERROR',
    'The operation could not be completed.',
    {
      recovery:
        'Retry a read operation, or inspect the saved operation before retrying a creation.',
    },
  );
}
