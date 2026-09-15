import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const skillNames = ['spatius-shared', 'spatius-avatar', 'spatius-video'];

// Release preparation runs before dependencies are installed. Keep this module
// dependency-free and preserve the rest of each skill verbatim.
export async function setVersion(root, version) {
  const match =
    typeof version === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    );
  if (
    !match ||
    match[0] !== version ||
    version.length > 256 ||
    match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part))) ||
    match[4]
      ?.split('.')
      .some((part) => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))
  )
    throw new Error('Expected a canonical X.Y.Z[-prerelease] release version.');
  const manifestPath = join(root, 'packages/cli/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.name !== '@spatius/cli')
    throw new Error('Unexpected CLI package name.');
  const changes = [];
  for (const name of skillNames) {
    const path = join(root, 'skills', name, 'SKILL.md');
    const content = await readFile(path, 'utf8');
    const front = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (
      !front ||
      !front[1].includes(`name: ${name}\n`) ||
      !/^metadata:\n {2}version: (['"])[^'"\n]+\1$/m.test(front[1])
    )
      throw new Error('Expected quoted metadata.version in ' + path);
    const updated = front[0].replace(
      /^(metadata:\n {2}version: )(['"])[^'"\n]+\2$/m,
      (_line, prefix, quote) => prefix + quote + version + quote,
    );
    changes.push([path, updated + content.slice(front[0].length)]);
  }
  // Validate all inputs before changing any file.
  manifest.version = version;
  changes.push([manifestPath, JSON.stringify(manifest, null, 2) + '\n']);
  for (const [path, content] of changes) await writeFile(path, content);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3)
      throw new Error('Usage: node scripts/set-version.mjs <version>');
    await setVersion(
      fileURLToPath(new URL('../', import.meta.url)),
      process.argv[2],
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
