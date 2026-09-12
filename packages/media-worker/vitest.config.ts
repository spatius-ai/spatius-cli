import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          PUBLIC_URL: 'https://media.example.test',
          SIGNING_KEYS: JSON.stringify({
            v1: 'test-key-012345678901234567890123456789',
          }),
        },
      },
    }),
  ],
  test: { testTimeout: 15000 },
});
