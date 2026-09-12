import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/commands.ts'],
  format: ['esm'],
  target: 'node22',
  noExternal: ['@spatius/contracts'],
  clean: true,
});
