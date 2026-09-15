import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildProgram,
  commandSchema,
  definitions,
  resolveCompletion,
} from '../src/commands.js';
import { completionScript, completionShells } from '../src/completions.js';

const noContext = () => {
  throw new Error('Completion must not initialize credentials or workflows');
};
const root = buildProgram(
  noContext,
  () => {
    throw new Error('Unexpected JSON output');
  },
  'test',
);

describe('completion contract', () => {
  it.each(completionShells)(
    'prints a clean %s script without a context',
    async (shell) => {
      const emit = vi.fn();
      const program = buildProgram(noContext, emit, 'test');
      const writeOut = vi.fn();
      program.configureOutput({ writeOut });
      await program.parseAsync(['completion', shell], { from: 'user' });
      expect(writeOut).toHaveBeenCalledExactlyOnceWith(completionScript(shell));
      expect(emit).not.toHaveBeenCalled();
      expect(commandSchema('completion').commands[0]).toMatchObject({
        outputMode: 'script',
        supportsJson: false,
      });
    },
  );

  it.each([
    ['completion'],
    ['completion', 'nu'],
    ['completion', 'bash', '--json'],
    ['--json', 'completion', 'zsh'],
  ])('rejects invalid script requests: %j', async (...args) => {
    const program = buildProgram(noContext, () => {}, 'test');
    const writeOut = vi.fn();
    program.configureOutput({ writeOut, writeErr: () => {} });
    await expect(
      program.parseAsync(args, { from: 'user' }),
    ).rejects.toBeDefined();
    expect(writeOut).not.toHaveBeenCalled();
  });

  it('keeps the internal query hidden and treats all words as data', async () => {
    const program = buildProgram(noContext, () => {}, 'test');
    const writeOut = vi.fn();
    program.configureOutput({ writeOut });
    await program.parseAsync(
      ['__complete', '--', 'videos', 'create', '--fit', 'c'],
      { from: 'user' },
    );
    expect(writeOut).toHaveBeenCalledExactlyOnceWith('plain:\ncrop\ncontain\n');
    expect(program.helpInformation()).not.toContain('__complete');
    expect(resolveCompletion(root, ['']).candidates).not.toContain(
      '__complete',
    );
  });

  it('discovers every public command, flag, and choice from the registry', () => {
    for (const def of definitions) {
      const words = def.path.split(' ');
      expect(
        resolveCompletion(root, [...words.slice(0, -1), '']).candidates,
      ).toContain(words.at(-1));
      for (const flag of def.flags ?? []) {
        const name = flag.flags.split(' ')[0]!;
        expect(resolveCompletion(root, [...words, '--']).candidates).toContain(
          name,
        );
        if (flag.choices)
          expect(
            resolveCompletion(root, [...words, name, '']).candidates,
          ).toEqual(flag.choices);
      }
    }
  });

  it.each([
    {
      words: ['--json', 'avatars', 'jobs', ''],
      expected: ['get', 'list', 'wait'],
    },
    {
      words: ['videos', 'create', '--name', 'avatars', '--fit', 'c'],
      expected: ['crop', 'contain'],
    },
    {
      words: ['videos', 'create', '--fit=c'],
      expected: ['--fit=crop', '--fit=contain'],
    },
    {
      words: ['videos', 'create', '--audio=https://example.com/a.wav', '--b'],
      expected: ['--background', '--background-color', '--background-fit'],
    },
    {
      words: ['schema', 'avatars', 'jobs', ''],
      expected: ['get', 'list', 'wait'],
    },
    {
      words: ['help', 'vi'],
      expected: ['videos'],
    },
    { words: ['avatars', 'help', 'j'], expected: ['jobs'] },
    { words: ['completion', ''], expected: completionShells },
  ])('completes partial argv: $words', ({ words, expected }) => {
    expect(resolveCompletion(root, words).candidates).toEqual(
      expect.arrayContaining(expected),
    );
  });

  it.each([
    ['videos', 'get', ''],
    ['videos', 'create', '--name', ''],
    ['videos', 'create', '--width', ''],
    ['videos', 'create', '--audio', 'https://example.com/'],
    ['videos', 'create', '--', '--'],
    ['videos', 'create', '--unknown', ''],
    ['unknown', ''],
    ['help', 'videos', ''],
    ['assets', 'upload', './done.wav', ''],
  ])('does not invent account data or file suggestions: %j', (...words) => {
    const result = resolveCompletion(root, words);
    expect(result.files).toBe(false);
    expect(result.candidates.filter((c) => !c.startsWith('-'))).toEqual([]);
  });

  it.each([
    ['assets', 'upload', ''],
    ['assets', 'upload', '--kind', 'audio', './'],
    ['assets', 'upload', '--', '-portrait'],
    ['avatars', 'create', '--image', ''],
    ['videos', 'create', '--audio', './speech'],
    ['videos', 'create', '--background=./'],
    ['videos', 'download', 'job-id', '--output', './'],
  ])('requests native filename completion: %j', (...words) => {
    expect(resolveCompletion(root, words)).toMatchObject({
      files: true,
      candidates: [],
    });
  });
});

let directory: string;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'spatius-completions-'));
  await writeFile(
    join(directory, 'spatius'),
    `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(resolve('node_modules/tsx/dist/loader.mjs'))} ${quote(resolve('src/cli.ts'))} "$@"\n`,
    { mode: 0o755 },
  );
  await writeFile(join(directory, 'speech sample.wav'), '');
  await mkdir(join(directory, 'media folder'));
  for (const shell of completionShells)
    await writeFile(
      join(directory, `completion.${shell}`),
      completionScript(shell),
    );
  await writeFile(join(directory, '_spatius'), completionScript('zsh'));
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const shell of completionShells) {
  const available = spawnSync(shell, ['--version']).status === 0;
  describe.skipIf(!available && !process.env.CI)(`${shell} adapter`, () => {
    function run(script: string, args: string[] = []) {
      const result = spawnSync(
        shell,
        shell === 'fish'
          ? ['--no-config', '-c', script, ...args]
          : ['-c', script, 'test', ...args],
        {
          cwd: directory,
          env: {
            ...process.env,
            PATH: directory + ':' + process.env.PATH,
            SPATIUS_CONFIG_DIR: join(directory, 'must-not-exist'),
            SPATIUS_STUDIO_URL: 'invalid-config-must-not-be-read',
            XDG_CONFIG_HOME: join(directory, 'config'),
            XDG_DATA_HOME: join(directory, 'data'),
            XDG_CACHE_HOME: join(directory, 'cache'),
          },
          encoding: 'utf8',
        },
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      return result.stdout.trim().split('\n').filter(Boolean);
    }
    function complete(words: string[]) {
      if (shell === 'bash')
        return run(
          'source ./completion.bash; if type compopt &>/dev/null; then compopt() { :; }; fi; COMP_WORDS=(spatius "$@"); COMP_CWORD=$(($#)); _spatius; printf "%s\\n" "${COMPREPLY[@]}"',
          words,
        );
      if (shell === 'zsh')
        return run(
          'autoload -Uz compinit; compinit -D -i; source ./completion.zsh; compadd() { shift; printf "%s\\n" "$@"; }; words=(spatius "$@"); CURRENT=$#words; PREFIX=$words[-1]; _spatius',
          words,
        );
      // complete -C executes fish’s real completion pipeline, including escaping.
      return run('source ./completion.fish; complete -C "$argv[1]"', [
        'spatius ' + words.map((w) => (w ? quote(w) : '')).join(' '),
      ]).map((line) => line.split('\t')[0]!);
    }
    it('is syntactically valid', () => {
      execFileSync(shell, ['-n', join(directory, `completion.${shell}`)]);
    });
    it('loads without running a completion', () => {
      expect(
        run(
          (shell === 'zsh' ? 'autoload -Uz compinit; compinit -D -i; ' : '') +
            `source ./completion.${shell}`,
        ),
      ).toEqual([]);
    });
    it('completes nested commands and flags', () => {
      expect(complete(['avatars', 'jobs', 'l'])).toContain('list');
      expect(complete(['videos', 'create', '--back'])).toEqual(
        expect.arrayContaining([
          '--background',
          '--background-color',
          '--background-fit',
        ]),
      );
    });
    it('completes both forms of choice arguments', () => {
      expect(complete(['videos', 'create', '--fit', 'c'])).toEqual(
        expect.arrayContaining(['crop', 'contain']),
      );
      expect(complete(['videos', 'create', '--fit=c'])).toEqual(
        expect.arrayContaining(['--fit=crop', '--fit=contain']),
      );
    });
    if (shell === 'bash') {
      it('handles Readline word breaks around equals and URLs', () => {
        expect(complete(['videos', 'create', '--fit', '='])).toEqual([
          'crop',
          'contain',
        ]);
        expect(complete(['videos', 'create', '--fit', '=', 'c'])).toEqual([
          'crop',
          'contain',
        ]);
        expect(
          complete([
            'videos',
            'create',
            '--audio',
            'https',
            ':',
            '//example.com/a',
            '--fit',
            '',
          ]),
        ).toEqual(['crop', 'contain']);
      });
      it('preserves spaces in filenames', () => {
        expect(complete(['assets', 'upload', 'speech'])).toEqual([
          'speech sample.wav',
        ]);
        expect(
          complete(['videos', 'download', 'id', '--output', '=', 'speech']),
        ).toEqual(['speech sample.wav']);
      });
    }
    if (shell === 'fish') {
      it('escapes filenames with spaces', () => {
        expect(complete(['assets', 'upload', 'speech']).join('\n')).toContain(
          'speech',
        );
        expect(
          complete(['videos', 'create', '--audio=speech']).join('\n'),
        ).toContain('sample.wav');
      });
    }
    if (shell === 'zsh') {
      it('autoloads from fpath on the first completion', () => {
        expect(
          run(
            'fpath=("$PWD" $fpath); autoload -Uz _spatius; compadd() { shift; printf "%s\\n" "$@"; }; words=(spatius videos create --fit c); CURRENT=5; PREFIX=c; _spatius',
          ),
        ).toEqual(['crop', 'contain']);
      });
      it('delegates paths to the native file completer', () => {
        expect(
          run(
            'autoload -Uz compinit; compinit -D -i; source ./completion.zsh; _files() { print -r -- "$PREFIX"; }; compset() { PREFIX=${PREFIX#--output=}; }; words=(spatius videos download id --output=speech); CURRENT=5; PREFIX=--output=speech; _spatius',
          ),
        ).toEqual(['speech']);
      });
    }
  });
}
