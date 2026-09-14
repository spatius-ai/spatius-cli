import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    commands: 'src/commands.ts',
    'install-assets': 'src/install/assets.ts',
  },
  format: ['esm'],
  target: 'node22',
  noExternal: ['@spatius/contracts'],
  clean: true,
});
