import { defineConfig } from '@playwright/test';

const port = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'node --import tsx src/server/index.ts',
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(port),
      NODE_ENV: 'test',
      AI_PROVIDER: 'fake',
    },
  },
});
