import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { buildProgram, definitions } from '../packages/cli/dist/commands.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const skills = join(root, 'skills');
let examples = 0;
function argv(line) {
  return (line.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).map((v) =>
    v.replace(/^(['"])(.*)\1$/, '$2'),
  );
}
async function checkCommand(line) {
  const program = buildProgram(
    () => {
      throw new Error('Skill parser validation must not execute a workflow.');
    },
    () => {},
    'test',
  );
  const suppress = (command) => {
    if (!command.commands.length) command.action(() => {});
    command.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    for (const child of command.commands) suppress(child);
  };
  suppress(program);
  try {
    await program.parseAsync(['node', ...argv(line)]);
  } catch (error) {
    if (error.exitCode !== 0)
      throw new Error(`Skill example failed to parse: ${line}`, {
        cause: error,
      });
  }
  examples++;
}
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!item.name.endsWith('.md')) continue;
    const content = await readFile(path, 'utf8');
    if (item.name === 'SKILL.md') {
      const front = content.match(/^---\n([\s\S]*?)\n---\n/);
      if (!front) throw new Error(`Missing skill frontmatter: ${path}`);
      const metadata = parse(front[1]);
      if (
        !/^[a-z0-9-]{1,64}$/.test(metadata.name) ||
        typeof metadata.description !== 'string' ||
        !metadata.description.trim()
      )
        throw new Error(`Invalid skill metadata: ${path}`);
      if (metadata.name !== directory.split('/').at(-1))
        throw new Error(`Skill folder/name mismatch: ${path}`);
    }
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1];
      if (/^https?:|^#/.test(link)) continue;
      const target = resolve(dirname(path), link.split('#')[0]);
      if (!target.startsWith(`${skills}/`))
        throw new Error(`Skill reference escapes the packaged skills: ${path}`);
      await stat(target);
    }
    for (const block of content.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g))
      for (const line of block[1].split('\n'))
        if (line.trim().startsWith('spatius ')) await checkCommand(line.trim());
  }
}
await walk(skills);
for (const definition of definitions) await checkCommand(definition.example);
console.log(
  `Validated three skills and ${examples} examples against the command parser.`,
);
