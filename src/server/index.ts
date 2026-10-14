import { existsSync } from 'node:fs';
import path from 'node:path';
import { createProvider } from '../ai/index.js';
import { ConfigError, loadConfig } from '../config/env.js';
import { migrate, openDatabase, Repository, type Db } from '../db/index.js';
import { JiraClient } from '../jira/client.js';
import { FixtureTicketSource } from '../jira/fixtures.js';
import type { TicketSource } from '../jira/resolver.js';
import { JobManager } from '../jobs/manager.js';
import { checkCodeContext, createRunner } from '../jobs/runner.js';
import { loadKnowledge } from '../knowledge/index.js';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

/** What the server uses when DATABASE_URL is not set: a Postgres kept in a local folder. */
const DEFAULT_DATABASE_URL = 'pglite://./.data/qa-assistant';

/** Used when Jira is not set up: the run fails with a clear message instead of the server not starting. */
const missingJira: TicketSource = {
  async getIssue() {
    throw new ConfigError(['JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not set']);
  },
  async searchIssues() {
    throw new ConfigError(['JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not set']);
  },
};

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel });
  const provider = createProvider(config.ai, {
    onSwitch: (e) =>
      log.warn(
        { from: e.from, to: e.to ?? null },
        e.to
          ? 'a model used its daily limit, switching'
          : 'a model used its daily limit, none left',
      ),
  });

  // The server always has a database, because history, editing and approving need one. With no
  // DATABASE_URL it keeps a Postgres in a local folder, so there is nothing to install.
  const databaseUrl = config.databaseUrl ?? DEFAULT_DATABASE_URL;
  const db: Db = await openDatabase(databaseUrl);
  await migrate(db);
  const repository = new Repository(db);
  log.info(
    { source: config.databaseUrl ? 'DATABASE_URL' : 'local folder' },
    config.databaseUrl
      ? 'database ready'
      : 'database ready in a local folder (set DATABASE_URL to use a Postgres server)',
  );

  const tickets: TicketSource = config.ticketFixturesDir
    ? new FixtureTicketSource(config.ticketFixturesDir)
    : config.jira
      ? new JiraClient({
          baseUrl: config.jira.baseUrl,
          email: config.jira.email,
          apiToken: config.jira.apiToken,
          ...(config.jira.acceptanceCriteriaField && {
            acceptanceCriteriaField: config.jira.acceptanceCriteriaField,
          }),
        })
      : missingJira;

  const jobs = new JobManager(
    createRunner({
      provider,
      tickets,
      config,
      knowledge: () => loadKnowledge('knowledge'),
      repository,
    }),
    {
      maxConcurrent: config.maxConcurrentRuns,
      onError: (error, job) =>
        log.error({ err: error, jobId: job.id }, 'a run failed unexpectedly'),
    },
  );

  const staticDir = path.resolve('web/dist');
  const serveWeb = existsSync(path.join(staticDir, 'index.html'));

  const app = createApp(
    {
      jobs,
      repository,
      ...(config.apiToken && { apiToken: config.apiToken }),
      enableRelease: config.jira?.enableRelease ?? false,
      // Real tickets and code go to the AI provider only with the setting that says so.
      precheck: (input) => (config.ticketFixturesDir ? undefined : checkCodeContext(config, input)),
      onError: (error) => log.error({ err: error }, 'unexpected API error'),
      ready: () => db.query('SELECT 1'),
      limits: {
        perMinute: config.rateLimitPerMinute,
        generatePerMinute: config.generateLimitPerMinute,
      },
    },
    {
      ...(serveWeb && { staticDir }),
      logger: log,
      trustProxy: config.trustProxy,
      hsts: config.enableHsts,
    },
  );

  const server = app.listen(config.port, () => {
    log.info({ port: config.port, env: config.env, webInterface: serveWeb }, 'listening');
    if (!serveWeb) log.warn('the web interface is not built (npm run build:web)');
    if (!config.apiToken)
      log.warn('API_TOKEN is not set: the API is open to anyone who can reach it');
  });

  const shutdown = async () => {
    log.info('shutting down: stopping runs that are in progress');
    jobs.cancelAll();
    server.close();
    await jobs.whenIdle();
    await db.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  // The logger may not exist yet (a bad setting stops the server before it is built).
  if (error instanceof ConfigError) console.error(error.message);
  else createLogger().error({ err: error }, 'the server could not start');
  process.exit(1);
});
