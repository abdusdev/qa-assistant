import { defineConfig } from '@playwright/test';

const port = 3100;
const guardedPort = 3101;

// Two servers, both offline (a demo AI, tickets from files, a database in memory):
//   3100 is open, the way it runs on a developer's machine
//   3101 asks for an access token, the way it should run when others can reach it
// The web interface is built by `npm run test:e2e` before these start.
const offline = {
  NODE_ENV: 'test',
  AI_PROVIDER: 'fake',
  TICKET_FIXTURES_DIR: 'evals/tickets',
  DATABASE_URL: 'pglite://memory',
  // Tests run side by side and each starts runs, so they must not queue behind each other.
  MAX_CONCURRENT_RUNS: '6',
  LOG_LEVEL: 'warn',
  // The limits have their own tests; here many tests share one address and must not trip them.
  RATE_LIMIT_PER_MINUTE: '100000',
  GENERATE_LIMIT_PER_MINUTE: '10000',
};

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
  webServer: [
    {
      command: 'node --import tsx src/server/index.ts',
      url: `http://127.0.0.1:${port}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...offline, PORT: String(port) },
    },
    {
      command: 'node --import tsx src/server/index.ts',
      url: `http://127.0.0.1:${guardedPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...offline, PORT: String(guardedPort), API_TOKEN: 'e2e-access-token-1234' },
    },
  ],
});
