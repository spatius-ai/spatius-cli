import { execFileSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { integrity, PACKAGE_NAME } from './release.mjs';
import { parse } from 'yaml';

// Artifact validation never starts an external update check.
process.env.SPATIUS_NO_UPDATE_NOTIFIER = '1';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const { values } = parseArgs({
  args,
  options: { 'artifact-dir': { type: 'string' } },
});
const manifest = JSON.parse(
  await readFile(join(root, 'packages/cli/package.json'), 'utf8'),
);
if (manifest.name !== PACKAGE_NAME || manifest.bin?.spatius !== './dist/cli.js')
  throw new Error('Expected @spatius/cli with the spatius executable.');
const staging = await mkdtemp(join(tmpdir(), 'spatius-package-'));
try {
  const raw = execFileSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', staging],
    { cwd: join(root, 'packages/cli'), encoding: 'utf8' },
  );
  const [pack] = JSON.parse(raw);
  if (
    pack.name !== PACKAGE_NAME ||
    pack.version !== manifest.version ||
    pack.filename !== 'spatius-cli-' + manifest.version + '.tgz'
  )
    throw new Error(
      'Packed package name/version does not match the CLI manifest.',
    );
  const paths = new Set(pack.files.map((file) => file.path));
  for (const path of [
    'dist/cli.js',
    'dist/update-check.js',
    'README.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'skills/spatius-shared/SKILL.md',
    'skills/spatius-shared/references/recovery.md',
    'skills/spatius-shared/references/completions.md',
    'docs/completions.md',
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
  const installed = join(staging, 'node_modules/@spatius/cli');
  const executable = join(installed, 'dist/cli.js');
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
  for (const shell of ['bash', 'zsh', 'fish']) {
    const script = execFileSync(
      process.execPath,
      [executable, 'completion', shell],
      {
        cwd: staging,
        encoding: 'utf8',
        env: { ...process.env, SPATIUS_STUDIO_URL: 'must-not-read-config' },
      },
    );
    if (!script.startsWith('#') || !script.includes('__complete'))
      throw new Error(`Packaged ${shell} completion script smoke test failed.`);
  }
  const completion = execFileSync(
    process.execPath,
    [executable, '__complete', '--', 'videos', 'create', '--fit', 'c'],
    {
      cwd: staging,
      encoding: 'utf8',
      env: { ...process.env, SPATIUS_STUDIO_URL: 'must-not-read-config' },
    },
  );
  if (completion !== 'plain:\ncrop\ncontain\n')
    throw new Error('Packaged completion query smoke test failed.');
  const binary = join(
    staging,
    'node_modules/.bin/spatius' + (process.platform === 'win32' ? '.cmd' : ''),
  );
  const version = execFileSync(binary, ['--version'], {
    cwd: staging,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).trim();
  if (version !== manifest.version)
    throw new Error(
      'Installed spatius executable does not report the package version.',
    );
  execFileSync(binary, ['--help'], {
    cwd: staging,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  execFileSync(process.execPath, [executable, 'install', '--help'], {
    cwd: staging,
    stdio: 'pipe',
  });
  const installSchema = JSON.parse(
    execFileSync(process.execPath, [executable, 'schema', 'install'], {
      cwd: staging,
      encoding: 'utf8',
    }),
  );
  if (
    !installSchema.data.commands[0].interactive ||
    installSchema.data.commands[0].supportsJson !== false
  )
    throw new Error(
      'Packaged installer schema is missing its human-output contract.',
    );
  // Import from the installed artifact, not the workspace: validates runtime asset paths.
  const assets = await import(
    pathToFileURL(join(installed, 'dist/install-assets.js')).href
  );
  if (
    (await realpath(assets.bundledSkillsDirectory())) !==
    (await realpath(join(installed, 'skills')))
  )
    throw new Error(
      'Packaged installer does not resolve its own bundled skills.',
    );
  for (const name of assets.skillNames) {
    const content = await readFile(
      join(assets.bundledSkillsDirectory(), name, 'SKILL.md'),
      'utf8',
    );
    const front = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (!front || parse(front[1]).metadata?.version !== version)
      throw new Error('Packaged skill version differs from the CLI: ' + name);
  }
  const updateSchema = JSON.parse(
    execFileSync(process.execPath, [executable, 'schema', 'update'], {
      cwd: staging,
      encoding: 'utf8',
    }),
  );
  if (
    updateSchema.data.commands[0].path !== 'update' ||
    updateSchema.data.commands[0].interactive ||
    !updateSchema.data.outputEnvelope.updateAvailable?.optional
  )
    throw new Error('Packaged update command contract is missing.');
  execFileSync(process.execPath, [executable, 'update', '--help'], {
    cwd: staging,
    stdio: 'pipe',
  });
  // No arguments means no work: verifies helper imports without contacting npm.
  execFileSync(process.execPath, [join(installed, 'dist/update-check.js')], {
    cwd: staging,
    stdio: 'pipe',
  });
  // Loading the lazy installer checks all declared runtime dependencies, but rejects before effects.
  try {
    execFileSync(process.execPath, [executable, 'install', '--json'], {
      cwd: staging,
      stdio: 'pipe',
    });
    throw new Error('Packaged installer unexpectedly accepted JSON mode.');
  } catch (error) {
    if (
      error.status !== 2 ||
      JSON.parse(error.stderr.toString()).error?.code !== 'INVALID_ARGUMENT'
    )
      throw new Error(
        'Packaged installer runtime/rejection smoke test failed.',
        { cause: error },
      );
  }
  // Agent guidance must come from this checkout, never a stale copied package directory.
  for (const path of paths) {
    if (
      !/^(skills\/|docs\/|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/.test(
        path,
      )
    )
      continue;
    if (
      !(await readFile(join(installed, path))).equals(
        await readFile(join(root, path)),
      )
    )
      throw new Error(
        'Packaged documentation differs from the release checkout: ' + path,
      );
  }
  const entry = await readFile(executable, 'utf8');
  if (!entry.startsWith('#!/usr/bin/env node'))
    throw new Error('Executable shebang missing.');
  if (values['artifact-dir']) {
    const directory = resolve(values['artifact-dir']);
    await mkdir(directory, { recursive: true });
    const tarball = join(staging, pack.filename);
    const metadata = {
      name: pack.name,
      version: pack.version,
      filename: pack.filename,
      integrity: integrity(await readFile(tarball)),
    };
    await copyFile(tarball, join(directory, pack.filename));
    await writeFile(
      join(directory, 'release-artifact.json'),
      JSON.stringify(metadata, null, 2) + '\n',
    );
  }
  console.log(
    `Validated npm artifact ${pack.filename}, CLI startup, and packaged skills.`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
