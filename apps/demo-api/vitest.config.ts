import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: resolve(__dirname, 'wrangler.jsonc') },
      miniflare: {
        bindings: {
          SECRET_HASH_KEY: 'test-secret-hash-key-that-is-at-least-32-bytes',
          REQUESTS_PER_MINUTE: '40',
          TRIP_QUOTA: '2',
          TEST_MIGRATIONS: await readD1Migrations(resolve(__dirname, 'migrations')),
        },
      },
    })),
  ],
  test: {
    include: ['apps/demo-api/test/**/*.spec.ts'],
    setupFiles: ['apps/demo-api/test/setup.ts'],
  },
});
