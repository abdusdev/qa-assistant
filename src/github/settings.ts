import type { AppConfig } from '../config/env.js';

export interface CodeContextRequest {
  /** What the person asked for on this run, when they said anything. */
  flags: {
    /** --code-context: use it even for example tickets. */
    force?: boolean;
    /** --no-code-context: leave it out of this run. */
    off?: boolean;
    /** --allow-code-to-ai: agree for this run only. */
    allow?: boolean;
  };
  /** True when the tickets come from Jira, false for the fictional example files. */
  realTickets: boolean;
}

export type CodeContextDecision =
  /** Use it. */
  | { use: true; repos: string[] }
  /** Leave it out, and say why. A "warn" means the person probably expected it. */
  | { use: false; reason: string; warn: boolean }
  /** Stop the run: it cannot go ahead the way the person set it up. */
  | { use: false; error: string };

const HOW_TO_CONSENT =
  'Source code goes to the AI provider, and on a free tier the provider may use that content.\n' +
  'If that is approved, set ALLOW_CODE_TO_AI=true in .env (or add --allow-code-to-ai for one run). ' +
  'To leave the code out of this run, add --no-code-context.';

/**
 * Decides whether a run includes the code changes of each ticket.
 *
 * It is on by default, so a real run is never quietly missing it. The only ways it is not used:
 * the person turned it off, the tickets are the fictional examples, or GitHub is not set up (which
 * is reported as a warning). Agreement to send code to the AI provider is a separate, explicit
 * setting: without it the run stops instead of leaving the code out unnoticed.
 */
export function decideCodeContext(
  config: Pick<AppConfig, 'github'>,
  request: CodeContextRequest,
): CodeContextDecision {
  const { flags, realTickets } = request;

  if (flags.off) {
    return { use: false, reason: 'turned off for this run (--no-code-context)', warn: false };
  }
  if (!realTickets && !flags.force) {
    return {
      use: false,
      reason: 'the tickets are example files, which have no pull requests',
      warn: false,
    };
  }
  if (!flags.force && config.github?.codeContext === false) {
    return { use: false, reason: 'turned off by CODE_CONTEXT=false in .env', warn: false };
  }

  if (!config.github) {
    const message = 'GITHUB_TOKEN is not set in .env';
    return flags.force
      ? { use: false, error: `${message}, so code context cannot be used.` }
      : { use: false, reason: `${message}, so the cases are written without the code`, warn: true };
  }
  if (config.github.repos.length === 0) {
    const message = 'GITHUB_REPOS is empty in .env';
    return flags.force
      ? { use: false, error: `${message}, so code context cannot be used.` }
      : { use: false, reason: `${message}, so the cases are written without the code`, warn: true };
  }

  if (!flags.allow && !config.github.allowCodeToAi) {
    return {
      use: false,
      error: `Code context is on, but sending code has not been approved.\n${HOW_TO_CONSENT}`,
    };
  }

  return { use: true, repos: config.github.repos };
}
