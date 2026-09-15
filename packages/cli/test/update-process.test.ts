import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { skillNames } from '../src/install/assets.js';

// A real non-TTY CLI process with fake npm/npx executables. No global packages,
// user skills, or services are touched. Service unit tests cover Windows shims.
it.skipIf(process.platform === 'win32')(
  'updates through the real parser with closed stdin and no Studio context',
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'spatius-update-process-')),
    );
    try {
      const bin = join(directory, 'bin');
      const root = join(directory, 'node_modules');
      const pkg = join(root, '@spatius', 'cli');
      const log = join(directory, 'commands.jsonl');
      const installedSkills = join(directory, 'installed-skills');
      await mkdir(bin, { recursive: true });
      await mkdir(join(pkg, 'dist'), { recursive: true });
      await writeFile(
        join(pkg, 'package.json'),
        JSON.stringify({ name: '@spatius/cli', version: '0.1.0-beta.0' }),
      );
      const cliScript = `#!${process.execPath}\nprocess.stdout.write('1.2.3\\n');\n`;
      await writeFile(join(pkg, 'dist', 'cli.js'), cliScript);
      await writeFile(join(bin, 'spatius'), cliScript);
      await chmod(join(bin, 'spatius'), 0o755);
      for (const base of [join(pkg, 'skills'), installedSkills])
        for (const name of skillNames) {
          await mkdir(join(base, name), { recursive: true });
          await writeFile(
            join(base, name, 'SKILL.md'),
            `---\nname: ${name}\nmetadata:\n  version: '1.2.3'\n---\nGuidance.\n`,
          );
        }
      const prelude = `#!${process.execPath}
      const { appendFileSync, writeFileSync } = require('node:fs');
      const args = process.argv.slice(2);
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ executable: process.argv[1], args, cwd: process.cwd(), tty: !!process.stdin.isTTY }) + '\\n');
    `;
      await writeFile(
        join(bin, 'npm'),
        prelude +
          `
      if (args[0] === '--version') console.log('11.0.0');
      else if (args[0] === 'root') console.log(${JSON.stringify(root)});
      else if (args[0] === 'prefix') console.log(${JSON.stringify(directory)});
      else if (args[0] === 'install' && args[1] === '--global' && args[2] === '@spatius/cli@1.2.3') {
        writeFileSync(${JSON.stringify(join(pkg, 'package.json'))}, JSON.stringify({ name: '@spatius/cli', version: '1.2.3' }));
        console.log('npm human output');
      } else process.exitCode = 8;
    `,
      );
      await writeFile(
        join(bin, 'npx'),
        prelude +
          `
      if (args[0] === '--version') console.log('11.0.0');
      else if (args[2] === 'update') console.log('skills human output');
      else if (args[2] === 'list') console.log(JSON.stringify(${JSON.stringify(skillNames)}.map(name => ({ name, scope: args.includes('--global') ? 'global' : 'project', path: ${JSON.stringify(installedSkills)} + '/' + name }))));
      else process.exitCode = 9;
    `,
      );
      await chmod(join(bin, 'npm'), 0o755);
      await chmod(join(bin, 'npx'), 0o755);
      const preload = join(directory, 'registry.mjs');
      await writeFile(
        preload,
        `globalThis.fetch = async (url) => {
      if (url !== 'https://registry.npmjs.org/-/package/@spatius%2Fcli/dist-tags') throw new Error('Unexpected network access');
      return Response.json({ latest: '1.2.3' });
    };`,
      );
      const source = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
      const tsx = fileURLToPath(
        new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url),
      );
      const run = () =>
        spawnSync(
          process.execPath,
          ['--import', preload, '--import', tsx, source, 'update', '--json'],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 15000,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              PATH: bin + delimiter + process.env.PATH,
              SPATIUS_CONFIG_DIR: join(directory, 'config'),
              SPATIUS_STUDIO_URL: 'invalid-on-purpose',
              SPATIUS_MEDIA_URL: 'invalid-on-purpose',
            },
          },
        );
      const updated = run();
      expect(updated.status, updated.stderr).toBe(0);
      expect(updated.stderr).toBe('');
      expect(JSON.parse(updated.stdout)).toMatchObject({
        ok: true,
        data: {
          cli: { version: '1.2.3', reused: false },
          skillsCommand: 'completed',
        },
      });
      const commands = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        commands.every(
          (command) => command.cwd === directory && command.tty === false,
        ),
      ).toBe(true);
      expect(
        commands.find((command) => command.args[2] === 'update').args,
      ).toEqual(['--yes', 'skills', 'update', ...skillNames, '--yes']);
      const repeated = run();
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(JSON.parse(repeated.stdout).data.cli.reused).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
