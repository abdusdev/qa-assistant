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
  const provider = createProvider(config.ai, {
    onSwitch: (e) =>
      console.log(
        `${e.from} has used its daily limit. ${e.to ? `Using ${e.to}.` : 'No model left.'}`,
      ),
  });

  let db: Db | undefined;
  let repository: Repository | undefined;
  if (config.databaseUrl) {
    db = await openDatabase(config.databaseUrl);
    await migrate(db);
    repository = new Repository(db);
  }

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
      ...(repository && { repository }),
    }),
    {
      maxConcurrent: config.maxConcurrentRuns,
      onError: (error, job) => console.error(`Job ${job.id} failed unexpectedly:`, error),
    },
  );

  const app = createApp({
    jobs,
    ...(repository && { repository }),
    ...(config.apiToken && { apiToken: config.apiToken }),
    enableRelease: config.jira?.enableRelease ?? false,
    // Real tickets and code go to the AI provider only with the setting that says so.
    precheck: (input) => (config.ticketFixturesDir ? undefined : checkCodeContext(config, input)),
    onError: (error) => console.error('Unexpected API error:', error),
  });

  const server = app.listen(config.port, () => {
    console.log(`qa-assistant listening on port ${config.port} (${config.env})`);
    if (!config.apiToken)
      console.log('API_TOKEN is not set: the API is open to anyone who can reach it.');
  });

  const shutdown = async () => {
    console.log('Shutting down: stopping runs that are in progress.');
    jobs.cancelAll();
    server.close();
    await jobs.whenIdle();
    await db?.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
