import { cp, mkdir, chmod, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = join(root, 'packages/cli');
for (const directory of ['skills', 'docs']) {
  await rm(join(target, directory), { recursive: true, force: true });
  await mkdir(join(target, directory), { recursive: true });
  await cp(join(root, directory), join(target, directory), { recursive: true });
}
for (const file of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
  await cp(join(root, file), join(target, file));
await chmod(join(target, 'dist/cli.js'), 0o755);
