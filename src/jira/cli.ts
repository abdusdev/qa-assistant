/**
 * Manual check helper: prints tickets as the AI will see them.
 *   npm run jira:ticket -- SHP-4085 SHP-4086
 */
import { ConfigError, loadConfig } from '../config/env.js';
import { JiraClient } from './client.js';
import { JiraError } from './errors.js';
import type { Ticket } from './ticket.js';

function format(ticket: Ticket): string {
  const lines = [
    `${ticket.key}: ${ticket.summary}`,
    `Type: ${ticket.type} | Status: ${ticket.status}` +
      (ticket.parentKey ? ` | Epic/parent: ${ticket.parentKey}` : ''),
    `URL: ${ticket.url}`,
    '',
    'Description:',
    ticket.description || '(none)',
  ];
  if (ticket.acceptanceCriteria) lines.push('', 'Acceptance criteria:', ticket.acceptanceCriteria);
  if (ticket.comments.length > 0) {
    lines.push('', `Comments (${ticket.comments.length}):`);
    for (const comment of ticket.comments) {
      lines.push(`- ${comment.author} (${comment.created}): ${comment.body}`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const keys = process.argv.slice(2);
  if (keys.length === 0) {
    console.error('Usage: npm run jira:ticket -- SHP-1234 [SHP-5678 ...]');
    process.exitCode = 1;
    return;
  }

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
    ...(jira.acceptanceCriteriaField && { acceptanceCriteriaField: jira.acceptanceCriteriaField }),
  });

  for (const key of keys) {
    try {
      console.log(`${format(await client.getIssue(key))}\n${'-'.repeat(60)}`);
    } catch (error) {
      console.error(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
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
