import { defineConfig, devices } from '@playwright/test';

const edgeExecutablePath = process.env['NGRX_OFFLINE_EDGE_PATH'];

export default defineConfig({
  testDir: './e2e/browser',
  outputDir: './artifacts/playwright',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  webServer: [
    {
      command: 'node scripts/static-server.mjs',
      url: 'http://127.0.0.1:4200/e2e/browser/foreground-fixture.html',
      reuseExistingServer: !process.env['CI'],
      env: { NGRX_OFFLINE_E2E_PORT: '4200' },
    },
    {
      command: 'node scripts/start-e2e-api.mjs',
      url: 'http://127.0.0.1:8787/v1/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
  ],
  use: {
    baseURL: 'http://127.0.0.1:4200',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    {
      name: 'edge',
      use: {
        ...devices['Desktop Edge'],
        ...(edgeExecutablePath
          ? { launchOptions: { executablePath: edgeExecutablePath } }
          : { channel: 'msedge' as const }),
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], browserName: 'webkit' } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
});
