/**
 * Connection check: confirms the Jira settings in .env work.
 *   npm run jira:check
 * Prints who the credentials belong to and whether the configured project is visible.
 */
import { ConfigError, loadConfig } from '../config/env.js';
import { JiraClient } from './client.js';
import { JiraError } from './errors.js';

async function main(): Promise<void> {
  const { jira } = loadConfig();
  if (!jira) {
    console.error('Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in .env first.');
    process.exitCode = 1;
    return;
  }

  const client = new JiraClient({
    baseUrl: jira.baseUrl,
    email: jira.email,
    apiToken: jira.apiToken,
  });

  const status = await client.checkConnection(jira.project);
  console.log(`Connected to ${jira.baseUrl}`);
  console.log(`Signed in as: ${status.displayName}`);
  if (status.project) {
    const answer = status.project.accessible ? 'yes' : 'NO (check your access to the project)';
    console.log(`Can see project ${status.project.key}: ${answer}`);
    if (!status.project.accessible) process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof JiraError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
