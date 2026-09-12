import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const staging = await mkdtemp(join(tmpdir(), 'spatius-package-'));
try {
  const raw = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', staging],
    { cwd: join(root, 'packages/cli'), encoding: 'utf8' },
  );
  const [pack] = JSON.parse(raw);
  const paths = new Set(pack.files.map((file) => file.path));
  for (const path of [
    'dist/cli.js',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'skills/spatius-shared/SKILL.md',
    'skills/spatius-shared/references/recovery.md',
    'skills/spatius-avatar/SKILL.md',
    'skills/spatius-video/SKILL.md',
    'skills/spatius-video/references/inputs-and-recovery.md',
  ])
    if (!paths.has(path)) throw new Error(`Missing packaged file: ${path}`);
  if (
    [...paths].some((path) =>
      /(?:\.dev\.vars|credentials\.json|\.env$|\/test\/)/.test(path),
    )
  )
    throw new Error('Unwanted private/test file in package.');
  await writeFile(
    join(staging, 'package.json'),
    JSON.stringify({ name: 'package-smoke-consumer', private: true }),
  );
  const executable = join(staging, 'node_modules/spatius-cli/dist/cli.js');
  // Use only the declared dependency tree, not the source workspace.
  execFileSync(
    'npm',
    [
      'install',
      join(staging, pack.filename),
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ],
    { cwd: staging, stdio: 'pipe' },
  );
  const result = JSON.parse(
    execFileSync(process.execPath, [executable, 'schema', 'videos', 'create'], {
      cwd: staging,
      encoding: 'utf8',
    }),
  );
  if (!result.ok || result.data.commands[0].path !== 'videos create')
    throw new Error('Packaged CLI schema smoke test failed.');
  const entry = await readFile(executable, 'utf8');
  if (!entry.startsWith('#!/usr/bin/env node'))
    throw new Error('Executable shebang missing.');
  console.log(
    `Validated npm artifact ${pack.filename}, CLI startup, and packaged skills.`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
