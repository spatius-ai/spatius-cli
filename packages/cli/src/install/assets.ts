import { fileURLToPath } from 'node:url';

export const skillNames = ['spatius-shared', 'spatius-avatar', 'spatius-video'];
export function bundledSkillsDirectory(): string {
  // Works from the source module and from tsup's dist entry/chunks.
  return fileURLToPath(
    new URL(
      new URL(import.meta.url).pathname.endsWith('/src/install/assets.ts')
        ? '../../../../skills/'
        : '../skills/',
      import.meta.url,
    ),
  );
}
