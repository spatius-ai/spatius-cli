import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    commands: 'src/commands.ts',
    'install-assets': 'src/install/assets.ts',
    'update-check': 'src/update/check-worker.ts',
  },
  format: ['esm'],
  target: 'node22',
  noExternal: ['@spatius/contracts'],
  clean: true,
});
