import { Argument, Command, Option } from 'commander';
import type { AuthManager } from './auth/index.js';
import type { Workflows } from './workflows/index.js';
import type { StudioWorkflows } from './workflows/studio.js';
import type { MediaKind, VideoSettings } from '@spatius/contracts';
import { CliError } from './core/errors.js';
import { completionScript, completionShells } from './completions.js';

type Values = Record<string, string | number | boolean | string[] | undefined>;
type Flag = {
  flags: string;
  description: string;
  type?: 'number';
  choices?: string[];
  default?: unknown;
  completion?: 'file';
};
interface Definition {
  path: string;
  description: string;
  args?: {
    name: string;
    required?: boolean;
    choices?: string[];
    completion?: 'file';
  }[];
  flags?: Flag[];
  output: string;
  example: string;
  interactive?: boolean;
  outputMode?: 'script';
  run?: (args: string[], values: Values, context: Context) => Promise<unknown>;
}
export interface Context {
  auth: AuthManager;
  workflows: Workflows;
  studio: StudioWorkflows;
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
const studioApp: Flag = {
  flags: '--app-id <id>',
  description: 'Owned Studio app ID (required).',
};
const showSecrets: Flag = {
  flags: '--show-secrets',
  description: 'Include raw API keys in stdout; keep output private.',
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
    path: 'completion',
    description: 'Print a shell completion script for bash, zsh, or fish.',
    args: [{ name: 'shell', required: true, choices: completionShells }],
    output:
      'Shell script on stdout; no JSON envelope or local configuration changes.',
    outputMode: 'script',
    example: 'spatius completion bash',
  },
  {
    path: 'install',
    description:
      'Interactively install the CLI, shell completions, agent skills, and Studio setup.',
    output:
      'Human-readable installation progress and summary; requires a terminal.',
    example: 'spatius install',
    interactive: true,
  },
  {
    path: 'update',
    description:
      'Update the global CLI and existing Spatius skills without prompts.',
    output:
      'Verified CLI version and per-skill version status; partial completion details on failure.',
    example: 'spatius update',
    flags: [
      {
        flags: '--channel <channel>',
        description:
          'Select an npm release channel; defaults to the installed release track.',
        choices: ['latest', 'beta'],
      },
    ],
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
    path: 'apps get',
    description: 'Read an owned Studio app without exposing API keys.',
    args: [{ name: 'id', required: true }],
    output: 'App metadata and apiKeyCount; no credentials.',
    example: 'spatius apps get app_example',
    run: async (a, _, c) => c.studio.getApp(a[0]!),
  },
  {
    path: 'apps create',
    description:
      'Create a Studio app. Does not create a key or change CLI setup.',
    flags: [
      {
        flags: '--name <name>',
        description: 'App name (required unless resuming).',
      },
      resume,
    ],
    output: 'operationId, appId, and name; no credentials.',
    example: 'spatius apps create --name "My app"',
    run: async (_, v, c) =>
      c.studio.createApp({ name: str(v, 'name'), resume: str(v, 'resume') }),
  },
  {
    path: 'apps delete',
    description:
      'Delete an owned Studio app and its API keys; clears matching CLI selection.',
    args: [{ name: 'id', required: true }],
    output: 'appId and deleted state.',
    example: 'spatius apps delete app_example',
    run: async (a, _, c) => c.studio.deleteApp(a[0]!),
  },
  {
    path: 'apps keys list',
    description: 'List a page of Studio API keys, hidden by default.',
    flags: [studioApp, ...pages, showSecrets],
    output:
      'appId, apiKeys with SHA-256 keyId and metadata, pagination.nextPageToken; raw keys only with --show-secrets.',
    example: 'spatius apps keys list --app-id app_example --page-size 20',
    run: async (_, v, c) =>
      c.studio.listKeys(str(v, 'appId') ?? '', {
        ...pageOptions(v),
        showSecrets: bool(v, 'showSecrets'),
      }),
  },
  {
    path: 'apps keys create',
    description: 'Create one Studio API key without changing CLI setup.',
    flags: [
      {
        ...studioApp,
        description: 'Owned Studio app ID (required unless resuming creation).',
      },
      resume,
      showSecrets,
    ],
    output:
      'operationId, appId, keyId, and metadata; raw key only with --show-secrets.',
    example: 'spatius apps keys create --app-id app_example',
    run: async (_, v, c) =>
      c.studio.createKey({
        appId: str(v, 'appId'),
        resume: str(v, 'resume'),
        showSecrets: bool(v, 'showSecrets'),
      }),
  },
  {
    path: 'apps keys delete',
    description:
      'Delete a Studio API key using its full keyId; clears a matching cached key.',
    args: [{ name: 'key-id', required: true }],
    flags: [studioApp],
    output: 'appId, keyId, and deleted state; no raw key.',
    example:
      'spatius apps keys delete 0000000000000000000000000000000000000000000000000000000000000000 --app-id app_example',
    run: async (a, v, c) => c.studio.deleteKey(str(v, 'appId') ?? '', a[0]!),
  },
  {
    path: 'apps session-tokens create',
    description:
      'Generate a 24-hour session token using an owned Studio app key, as in the frontend.',
    flags: [
      studioApp,
      {
        flags: '--key-id <key-id>',
        description:
          'Full keyId from apps keys list; defaults to the first available key.',
      },
    ],
    output:
      'operationId, appId, keyId, consoleOrigin, expireAt (Unix seconds), modelVersion, and secret sessionToken. Keep stdout private.',
    example: 'spatius apps session-tokens create --app-id app_example',
    run: async (_, v, c) =>
      c.studio.createSessionToken(str(v, 'appId') ?? '', str(v, 'keyId')),
  },
  {
    path: 'assets upload',
    description: 'Upload a local input to temporary storage.',
    output: 'Upload ID, accepted parts, status, and completed URL/expiration.',
    example: 'spatius assets upload ./speech.wav --kind audio',
    args: [{ name: 'file', required: true, completion: 'file' }],
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
        completion: 'file',
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
    description:
      'List public or custom avatars through Studio login; no app setup required.',
    output:
      'type, avatars, pagination.nextPageToken, and custom status counts when available.',
    example: 'spatius avatars list --type public --page-size 20',
    flags: [
      ...pages,
      {
        flags: '--type <type>',
        description: 'Studio avatar collection (default: custom).',
        choices: ['public', 'custom'],
        default: 'custom',
      },
      {
        flags: '--status <statuses>',
        description:
          'Custom avatars only: comma-separated success,generating,failure.',
      },
    ],
    run: async (_, v, c) =>
      c.studio.listAvatars({ ...pageOptions(v), type: str(v, 'type') }),
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
        completion: 'file',
        description: 'Supported audio input, at most 500 MiB.',
      },
      {
        flags: '--background <file-or-url>',
        completion: 'file',
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
        completion: 'file',
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
  const updateAvailable = {
    optional: true,
    currentVersion: 'string',
    latestVersion: 'string',
    message: 'string',
    command: 'spatius update',
  };
  return {
    schemaVersion: 1,
    executable: 'spatius',
    outputEnvelope: {
      schemaVersion: 1,
      ok: true,
      data: 'command-specific result',
      updateAvailable,
    },
    errorEnvelope: {
      schemaVersion: 1,
      ok: false,
      updateAvailable,
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
      ({
        path,
        description,
        args,
        flags,
        output,
        example,
        interactive,
        outputMode,
      }) => ({
        path,
        description,
        arguments: args ?? [],
        options: flags ?? [],
        output,
        examples: [example],
        ...(interactive
          ? { interactive: true, outputMode: 'human', supportsJson: false }
          : {}),
        ...(outputMode ? { outputMode, supportsJson: false } : {}),
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
    for (const arg of def.args ?? []) {
      const argument = new Argument(
        arg.required ? `<${arg.name}>` : `[${arg.name}]`,
      );
      if (arg.choices) argument.choices(arg.choices);
      cmd.addArgument(argument);
    }
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
      if (def.outputMode === 'script') {
        if (root.opts().json)
          throw new CliError(
            'INVALID_ARGUMENT',
            'Shell completion scripts do not support --json.',
            {
              exitCode: 2,
              recovery:
                'Run spatius completion bash, zsh, or fish without --json.',
            },
          );
        root.configureOutput().writeOut!(completionScript(args[0] as string));
        return;
      }
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
      if (def.path === 'update') {
        const { runUpdate } = await import('./update/index.js');
        emit(
          await runUpdate({
            version,
            channel: values.channel as 'latest' | 'beta' | undefined,
            signal: presentation.signal ?? new AbortController().signal,
          }),
        );
        return;
      }
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
  root
    .command('__complete', { hidden: true })
    .description('Internal shell completion protocol.')
    .argument('[words...]')
    .action((words: string[]) => {
      const result = resolveCompletion(root, words);
      root.configureOutput().writeOut!(
        [
          `${result.files ? 'files' : 'plain'}:${result.prefix}`,
          ...result.candidates,
        ].join('\n') + '\n',
      );
    });
  return root;
}

/** Resolve partial argv without parsing actions, reading config, or fetching account data. */
export function resolveCompletion(root: Command, words: string[]) {
  let command = root;
  let path: string[] = [];
  let positional = 0;
  let ended = false;
  let discovery: 'schema' | 'help' | undefined;
  let pending: Option | undefined;
  const empty = { files: false, prefix: '', candidates: [] as string[] };
  const options = () => {
    const result: Option[] = [];
    for (
      let current: Command | null = command;
      current;
      current = current.parent
    )
      result.push(...current.options);
    return result;
  };
  const findOption = (word: string) =>
    options().find((o) => o.long === word || o.short === word);
  const definition = () => definitions.find((d) => d.path === path.join(' '));
  const optionValue = (option: Option, value: string, prefix = '') => ({
    files:
      definition()?.flags?.some(
        (f) => f.flags === option.flags && f.completion === 'file',
      ) === true && !/^[a-z][a-z\d+.-]*:\/\//i.test(value),
    prefix,
    candidates: (option.argChoices ?? [])
      .filter((v) => v.startsWith(value))
      .map((v) => prefix + v),
  });
  for (const word of words.slice(0, -1)) {
    if (pending) {
      pending = undefined;
      continue;
    }
    if (!ended && word === '--') {
      ended = true;
      continue;
    }
    if (!ended && word.startsWith('-')) {
      const option = findOption(word.split('=')[0]!);
      if (!option) return empty;
      if (option.required && !word.includes('=')) pending = option;
      continue;
    }
    if (
      !discovery &&
      ((command === root && word === 'schema') ||
        (command.commands.length > 0 && word === 'help'))
    ) {
      discovery = word as 'schema' | 'help';
      continue;
    }
    const child = command.commands.find(
      (c) => c.name() === word && c.name() !== '__complete',
    );
    if (child && !positional) {
      // Commander's help command accepts one child name, while schema accepts
      // an entire command path. Extra help words are ignored by Commander.
      if (discovery === 'help') return empty;
      command = child;
      path = [...path, word];
    } else if (command.commands.length || discovery) return empty;
    else positional++;
  }
  const current = words.at(-1) ?? '';
  if (pending) return optionValue(pending, current);
  if (!ended && current.startsWith('-') && current.includes('=')) {
    const index = current.indexOf('=');
    const option = findOption(current.slice(0, index));
    return option?.required
      ? optionValue(
          option,
          current.slice(index + 1),
          current.slice(0, index + 1),
        )
      : empty;
  }
  const candidates: string[] = [];
  if (!ended && !discovery) {
    for (const option of options())
      candidates.push(
        ...[option.short, option.long].filter((v): v is string => !!v),
      );
    candidates.push('-h', '--help');
  }
  if (!current.startsWith('-') || ended) {
    if (!positional) {
      candidates.push(
        ...command.commands
          .map((c) => c.name())
          .filter(
            (name) =>
              name !== '__complete' &&
              (discovery !== 'schema' || name !== 'schema'),
          ),
      );
      if (command.commands.length && !discovery) candidates.push('help');
    }
    if (!discovery) {
      const argument = definition()?.args?.[positional];
      if (argument?.completion === 'file') return { ...empty, files: true };
      candidates.push(...(argument?.choices ?? []));
    }
  }
  return {
    ...empty,
    candidates: [...new Set(candidates)].filter((value) =>
      value.startsWith(current),
    ),
  };
}
