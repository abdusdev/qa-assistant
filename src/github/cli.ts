/**
 * Looks at GitHub by hand. Nothing here calls the AI, so it is safe to run before anyone has
 * agreed that code may be sent to a provider.
 *
 *   npm run github -- check
 *   npm run github -- find SHP-4103
 *   npm run github -- context SHP-4103     (prints exactly the code text that would be sent)
 *
 * Options: --repo owner/name   (otherwise GITHUB_REPOS is used)
 */
import { ConfigError, loadConfig } from '../config/env.js';
import { KEY_PATTERN } from '../jira/keys.js';
import type { Ticket } from '../jira/ticket.js';
import { GitHubClient } from './client.js';
import { CodeContextProvider, matchPullRequest } from './code-context.js';
import { GitHubError } from './errors.js';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { positional, flags };
}

const bareTicket = (key: string): Ticket => ({
  key,
  url: '',
  summary: '',
  type: '',
  status: '',
  description: '',
  labels: [],
  fixVersions: [],
  comments: [],
});

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, rawKey] = positional;

  const config = loadConfig();
  if (!config.github) {
    console.error(
      'Set GITHUB_TOKEN in .env first (a read-only token for the ShipNest repositories).',
    );
    process.exitCode = 1;
    return;
  }

  const repoFlag = flags.get('repo');
  const repos = typeof repoFlag === 'string' ? [repoFlag] : config.github.repos;
  const client = new GitHubClient({ token: config.github.token });

  if (command === 'check') {
    if (repos.length === 0) {
      console.error('Set GITHUB_REPOS in .env (owner/name, comma-separated) or pass --repo.');
      process.exitCode = 1;
      return;
    }
    const status = await client.checkConnection(repos);
    console.log(`Token belongs to: ${status.login}`);
    for (const repo of status.repos) {
      console.log(`  ${repo.accessible ? 'can read' : 'CANNOT read'}  ${repo.repo}`);
    }
    if (status.repos.some((repo) => !repo.accessible)) process.exitCode = 1;
    return;
  }

  const key = rawKey?.trim().toUpperCase();
  if ((command !== 'find' && command !== 'context') || !key || !KEY_PATTERN.test(key)) {
    console.error(
      'Usage: npm run github -- check\n' +
        '       npm run github -- find <TICKET-KEY> [--repo owner/name]\n' +
        '       npm run github -- context <TICKET-KEY> [--repo owner/name]',
    );
    process.exitCode = 1;
    return;
  }
  if (repos.length === 0) {
    console.error('Set GITHUB_REPOS in .env (owner/name, comma-separated) or pass --repo.');
    process.exitCode = 1;
    return;
  }

  if (command === 'find') {
    for (const repo of repos) {
      const recent = await client.listRecentPullRequests(repo);
      const hits = recent.flatMap((pr) => matchPullRequest(pr, key) ?? []);
      const searched = hits.some((hit) => hit.matchedIn.some((where) => where !== 'body'))
        ? []
        : (await client.searchPullRequests(repo, key)).flatMap(
            (pr) => matchPullRequest(pr, key) ?? [],
          );
      const all = [
        ...hits,
        ...searched.filter((s) => !hits.some((h) => h.pr.number === s.pr.number)),
      ];

      console.log(`${repo}: ${all.length} pull request(s) mention ${key}`);
      for (const { pr, matchedIn } of all) {
        const state = pr.merged ? 'merged' : pr.state;
        console.log(
          `  #${pr.number} [${state}] (${matchedIn.join(', ')}) ${pr.title}\n    ${pr.url}`,
        );
      }
    }
    return;
  }

  const provider = new CodeContextProvider(client, { repos });
  const context = await provider.contextFor(bareTicket(key));
  console.log(JSON.stringify(context.meta, null, 2));
  for (const warning of context.warnings ?? []) console.log(`! ${warning}`);
  if (context.codeChanges) {
    console.log(
      `\n----- code text that would be sent to the AI (${context.codeChanges.length} characters) -----`,
    );
    console.log(context.codeChanges);
    console.log('----- end -----');
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof GitHubError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
