import { Command, Option } from 'commander';
import type { AuthManager } from './auth/index.js';
import type { Workflows } from './workflows/index.js';
import type { MediaKind, VideoSettings } from '@spatius/contracts';
import { CliError } from './core/errors.js';

type Values = Record<string, string | number | boolean | string[] | undefined>;
type Flag = {
  flags: string;
  description: string;
  type?: 'number';
  choices?: string[];
  default?: unknown;
};
interface Definition {
  path: string;
  description: string;
  args?: { name: string; required?: boolean }[];
  flags?: Flag[];
  output: string;
  example: string;
  interactive?: boolean;
  run?: (args: string[], values: Values, context: Context) => Promise<unknown>;
}
export interface Context {
  auth: AuthManager;
  workflows: Workflows;
  signal: AbortSignal;
  progress: (event: unknown) => void;
}
const timeout: Flag = {
  flags: '--timeout <seconds>',
  description: 'Wait deadline in seconds (default: 600).',
  type: 'number',
};
const resume: Flag = {
  flags: '--resume <operation-id>',
  description: 'Resume a saved operation without supplying new input.',
};
const wait: Flag = {
  flags: '--wait',
  description: 'Wait for the admitted job to finish.',
};
const dryRun: Flag = {
  flags: '--dry-run',
  description:
    'Validate and preview without network requests or local state changes.',
};
const pages: Flag[] = [
  {
    flags: '--page-size <number>',
    description: 'Results per page (1–100).',
    type: 'number',
  },
  {
    flags: '--page-token <token>',
    description:
      'Next page token returned by the preceding list; keep page size unchanged.',
  },
];
const status: Flag = {
  flags: '--status <statuses>',
  description: 'Comma-separated job status filters.',
};
const str = (v: Values, key: string) => v[key] as string | undefined;
const num = (v: Values, key: string) => v[key] as number | undefined;
const bool = (v: Values, key: string) => v[key] === true;
function pageOptions(v: Values) {
  return {
    pageSize: num(v, 'pageSize'),
    pageToken: str(v, 'pageToken'),
    statuses: str(v, 'status')?.split(','),
  };
}
function settings(v: Values): VideoSettings {
  return Object.fromEntries(
    [
      'width',
      'height',
      'fit',
      'backgroundColor',
      'backgroundFit',
      'leadInSeconds',
      'leadOutSeconds',
    ]
      .filter((key) => v[key] !== undefined)
      .map((key) => [key, v[key]]),
  ) as VideoSettings;
}

export const definitions: Definition[] = [
  {
    path: 'install',
    description:
      'Interactively install the CLI, agent skills, and Studio setup.',
    output:
      'Human-readable installation progress and summary; requires a terminal.',
    example: 'spatius install',
    interactive: true,
  },
  {
    path: 'auth login',
    description: 'Authorize this local CLI through Spatius Studio.',
    output: 'Authenticated user and selected app metadata; no credentials.',
    example: 'spatius auth login',
    flags: [
      {
        flags: '--no-browser',
        description: 'Print the approval URL without opening a browser.',
      },
      {
        ...timeout,
        description: 'Browser approval timeout in seconds (default: 300).',
      },
    ],
    run: async (_, v, c) =>
      c.auth.login({
        noBrowser: v.browser === false,
        timeoutMs: (num(v, 'timeout') ?? 300) * 1000,
        onAuthorize: (url) =>
          c.progress({
            event: 'authorization_required',
            url,
            requiresHuman: true,
          }),
        signal: c.signal,
      }),
  },
  {
    path: 'auth status',
    description: 'Inspect the active Studio login.',
    output: 'Authentication and account metadata.',
    example: 'spatius auth status',
    run: async (_, __, c) => c.auth.status(),
  },
  {
    path: 'auth logout',
    description: 'Revoke refresh access and remove local credentials.',
    output: 'Logged-out state.',
    example: 'spatius auth logout',
    run: async (_, __, c) => c.auth.logout(),
  },
  {
    path: 'setup',
    description: 'Create or reuse a Studio app and API key for this account.',
    output: 'appId, userId, and reuse information; no API key.',
    example: 'spatius setup',
    flags: [
      {
        flags: '--app-id <id>',
        description: 'Select an existing app owned by the authenticated user.',
      },
      {
        flags: '--retry-uncertain',
        description:
          'After reconciliation, allow one new app/key creation; an earlier request may already have created it.',
      },
    ],
    run: async (_, v, c) =>
      c.auth.setup({
        appId: str(v, 'appId'),
        retryUncertain: bool(v, 'retryUncertain'),
      }),
  },
  {
    path: 'apps list',
    description: 'List owned Studio apps without exposing their API keys.',
    output: 'Array of appId, name, and createdAt.',
    example: 'spatius apps list',
    run: async (_, __, c) => c.auth.listApps(),
  },
  {
    path: 'assets upload',
    description: 'Upload a local input to temporary storage.',
    output: 'Upload ID, accepted parts, status, and completed URL/expiration.',
    example: 'spatius assets upload ./speech.wav --kind audio',
    args: [{ name: 'file', required: true }],
    flags: [
      {
        flags: '--kind <kind>',
        description: 'Input purpose.',
        choices: ['avatar-image', 'audio', 'background'],
      },
      {
        flags: '--resume <upload-id>',
        description: 'Resume an existing upload of this same local file.',
      },
    ],
    run: async (a, v, c) => {
      const kind = str(v, 'kind');
      if (!kind)
        throw new CliError('INVALID_ARGUMENT', '--kind is required.', {
          exitCode: 2,
        });
      return c.workflows.upload(a[0]!, {
        kind: kind as MediaKind,
        resume: str(v, 'resume'),
      });
    },
  },
  {
    path: 'assets get',
    description: 'Inspect an owned temporary upload.',
    output: 'Upload status and accepted parts.',
    example: 'spatius assets get 00000000-0000-4000-8000-000000000001',
    args: [{ name: 'id', required: true }],
    run: async (a, _, c) => c.workflows.getUpload(a[0]!),
  },
  {
    path: 'assets abort',
    description:
      'Abort an unfinished upload and release storage after cleanup.',
    output: 'Aborted upload state.',
    example: 'spatius assets abort 00000000-0000-4000-8000-000000000001',
    args: [{ name: 'id', required: true }],
    run: async (a, _, c) => c.workflows.abortUpload(a[0]!),
  },
  {
    path: 'avatars create',
    description: 'Create an avatar from a local JPEG/PNG or public URL.',
    output: 'operationId, jobId, status, createdAt; optional completed job.',
    example: 'spatius avatars create --image ./portrait.png --name Presenter',
    flags: [
      {
        flags: '--image <file-or-url>',
        description:
          'Opaque JPEG/PNG, at most 5 MiB, shorter side at least 340 pixels.',
      },
      { flags: '--name <name>', description: 'Avatar display name.' },
      resume,
      wait,
      timeout,
      dryRun,
    ],
    run: async (_, v, c) =>
      c.workflows.createAvatar({
        image: str(v, 'image'),
        name: str(v, 'name'),
        resume: str(v, 'resume'),
        wait: bool(v, 'wait'),
        timeout: num(v, 'timeout'),
        dryRun: bool(v, 'dryRun'),
      }),
  },
  {
    path: 'avatars get',
    description: 'Read an account avatar.',
    output: 'Public Avatar API detail.',
    example: 'spatius avatars get 00000000-0000-4000-8000-000000000001',
    args: [{ name: 'id', required: true }],
    run: async (a, _, c) => c.workflows.getAvatar(a[0]!),
  },
  {
    path: 'avatars list',
    description: 'List account avatars.',
    output: 'Avatars and pagination.nextPageToken.',
    example: 'spatius avatars list --page-size 20',
    flags: pages,
    run: async (_, v, c) => c.workflows.listAvatars(pageOptions(v)),
  },
  {
    path: 'videos create',
    description: 'Render an avatar with audio and an optional background.',
    output: 'operationId, jobId, status, createdAt; optional completed job.',
    example:
      'spatius videos create --avatar-id 00000000-0000-4000-8000-000000000001 --audio ./speech.wav',
    flags: [
      {
        flags: '--avatar-id <id>',
        description: 'Public, assigned, or explicitly permitted avatar UUID.',
      },
      {
        flags: '--audio <file-or-url>',
        description: 'Supported audio input, at most 500 MiB.',
      },
      {
        flags: '--background <file-or-url>',
        description: 'Optional JPEG/PNG/WebP background, at most 50 MiB.',
      },
      { flags: '--name <name>', description: 'Video job name.' },
      {
        flags: '--request-id <uuid>',
        description: 'Retry identity; generated and saved when omitted.',
      },
      {
        flags: '--width <pixels>',
        description:
          'Even width, 64–1920 (default 1024; omitted with a background).',
        type: 'number',
      },
      {
        flags: '--height <pixels>',
        description:
          'Even height, 64–1920 (default 1024; omitted with a background).',
        type: 'number',
      },
      {
        flags: '--fit <fit>',
        description: 'Avatar fit (default crop; omitted with a background).',
        choices: ['crop', 'contain'],
      },
      {
        flags: '--background-color <hex>',
        description: 'Six-digit RGB color (default #000000).',
      },
      {
        flags: '--background-fit <fit>',
        description: 'Background fit (default cover).',
        choices: ['cover', 'contain', 'stretch'],
      },
      {
        flags: '--lead-in-seconds <seconds>',
        description: 'Additional initial idle time, 0–60.',
        type: 'number',
      },
      {
        flags: '--lead-out-seconds <seconds>',
        description: 'Additional final idle time, 0–60.',
        type: 'number',
      },
      resume,
      wait,
      timeout,
      dryRun,
    ],
    run: async (_, v, c) =>
      c.workflows.createVideo({
        avatarId: str(v, 'avatarId'),
        audio: str(v, 'audio'),
        background: str(v, 'background'),
        name: str(v, 'name'),
        requestId: str(v, 'requestId'),
        video: settings(v),
        resume: str(v, 'resume'),
        wait: bool(v, 'wait'),
        timeout: num(v, 'timeout'),
        dryRun: bool(v, 'dryRun'),
      }),
  },
  ...(['avatar', 'video'] as const).flatMap((kind) => {
    const prefix = kind === 'avatar' ? 'avatars jobs' : 'videos';
    return [
      {
        path: `${prefix} get`,
        description: `Read a ${kind} job.`,
        output: 'Job detail; a successful video includes a fresh download URL.',
        example: `spatius ${prefix} get 00000000-0000-4000-8000-000000000001`,
        args: [{ name: 'id', required: true }],
        run: async (a: string[], _: Values, c: Context) =>
          c.workflows.getJob(kind, a[0]!),
      },
      {
        path: `${prefix} list`,
        description: `List ${kind} jobs.`,
        output: 'Jobs and pagination.nextPageToken; no download URLs.',
        example: `spatius ${prefix} list --status processing`,
        flags: [...pages, status],
        run: async (_: string[], v: Values, c: Context) =>
          c.workflows.listJobs(kind, pageOptions(v)),
      },
      {
        path: `${prefix} wait`,
        description: `Wait for an existing ${kind} job without submitting another.`,
        output:
          'Terminal job detail. Deadline reached exits 3 and preserves the job.',
        example: `spatius ${prefix} wait 00000000-0000-4000-8000-000000000001 --timeout 600`,
        args: [{ name: 'id', required: true }],
        flags: [timeout],
        run: async (a: string[], v: Values, c: Context) =>
          c.workflows.waitJob(kind, a[0]!, { timeout: num(v, 'timeout') }),
      },
    ];
  }),
  {
    path: 'videos download',
    description: 'Fetch a fresh MP4 link and save the output atomically.',
    output: 'Saved file path and video job identity.',
    example:
      'spatius videos download 00000000-0000-4000-8000-000000000001 --output ./video.mp4',
    args: [{ name: 'id', required: true }],
    flags: [
      {
        flags: '--output <path>',
        description: 'Destination MP4 file (required).',
      },
      { flags: '--force', description: 'Replace an existing destination.' },
    ],
    run: async (a, v, c) => {
      const output = str(v, 'output');
      if (!output)
        throw new CliError('INVALID_ARGUMENT', '--output is required.', {
          exitCode: 2,
        });
      return c.workflows.download(a[0]!, { output, force: bool(v, 'force') });
    },
  },
];

export function commandSchema(path?: string) {
  const found = path ? definitions.filter((d) => d.path === path) : definitions;
  if (!found.length)
    throw new CliError(
      'UNKNOWN_COMMAND',
      'No command matches that schema path.',
      {
        exitCode: 2,
        recovery: 'Run spatius schema to discover available commands.',
      },
    );
  return {
    schemaVersion: 1,
    executable: 'spatius',
    outputEnvelope: {
      schemaVersion: 1,
      ok: true,
      data: 'command-specific result',
    },
    errorEnvelope: {
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'string',
        message: 'string',
        retryable: 'boolean',
        recovery: 'string?',
        details: 'object?',
      },
    },
    streams: { result: 'stdout', error: 'stderr', progress: 'stderr' },
    exitCodes: {
      0: 'success',
      1: 'operation failure',
      2: 'invalid arguments',
      3: 'wait deadline',
      130: 'interrupted',
    },
    commands: found.map(
      ({ path, description, args, flags, output, example, interactive }) => ({
        path,
        description,
        arguments: args ?? [],
        options: flags ?? [],
        output,
        examples: [example],
        ...(interactive
          ? { interactive: true, outputMode: 'human', supportsJson: false }
          : {}),
      }),
    ),
  };
}

export function buildProgram(
  getContext: () => Context,
  emit: (data: unknown) => void,
  version: string,
  presentation: { signal?: AbortSignal; onHumanOutput?: () => void } = {},
) {
  const root = new Command()
    .name('spatius')
    .description('Avatar and video workflows for coding agents.')
    .version(version)
    .option('--json', 'Use structured JSON output (the default).')
    .exitOverride();
  const groups = new Map<string, Command>([['', root]]);
  for (const def of definitions) {
    const parts = def.path.split(' ');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join(' ');
      let group = groups.get(key);
      if (!group) {
        group = parent.command(parts[i]!);
        groups.set(key, group);
      }
      parent = group;
    }
    const cmd = parent.command(parts.at(-1)!).description(def.description);
    for (const arg of def.args ?? [])
      cmd.argument(arg.required ? `<${arg.name}>` : `[${arg.name}]`);
    for (const flag of def.flags ?? []) {
      const option = new Option(flag.flags, flag.description);
      if (flag.choices) option.choices(flag.choices);
      if (flag.type === 'number')
        option.argParser((value) => {
          const parsed = Number(value);
          if (!value.trim() || !Number.isFinite(parsed))
            throw new CliError(
              'INVALID_ARGUMENT',
              'Expected a finite number.',
              { exitCode: 2 },
            );
          return parsed;
        });
      if (flag.default !== undefined) option.default(flag.default);
      cmd.addOption(option);
    }
    cmd.action(async (...args: unknown[]) => {
      if (def.interactive) {
        const json = root.opts().json === true;
        if (!json) presentation.onHumanOutput?.();
        const { runInstaller } = await import('./install/index.js');
        await runInstaller({
          version,
          json,
          signal: presentation.signal ?? new AbortController().signal,
        });
        return;
      }
      const count = def.args?.length ?? 0;
      const values = args[count] as Values;
      if (typeof values.timeout === 'number' && values.timeout <= 0)
        throw new CliError('INVALID_ARGUMENT', '--timeout must be positive.', {
          exitCode: 2,
        });
      emit(
        await def.run!(args.slice(0, count) as string[], values, getContext()),
      );
    });
  }
  root
    .command('schema')
    .description(
      'Describe commands and structured output for this CLI version.',
    )
    .argument('[command...]')
    .action((parts: string[]) =>
      emit(commandSchema(parts.length ? parts.join(' ') : undefined)),
    );
  return root;
}
