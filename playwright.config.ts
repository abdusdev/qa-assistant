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
    // The web interface is built first, because the server serves it from web/dist.
    command: 'npm run build:web && node --import tsx src/server/index.ts',
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(port),
      NODE_ENV: 'test',
      // Everything runs offline: a demo AI, tickets from files, and a database in memory.
      AI_PROVIDER: 'fake',
      TICKET_FIXTURES_DIR: 'evals/tickets',
      DATABASE_URL: 'pglite://memory',
    },
  },
});
