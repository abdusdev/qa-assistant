import type { Ticket } from '../jira/ticket.js';
import { AIError } from './errors.js';
import { extractJson, JsonExtractionError } from './json.js';
import {
  buildGenerationPrompt,
  buildReviewPrompt,
  buildRepairPrompt,
  PROMPT_VERSION,
  type BuiltPrompt,
  type PromptContext,
} from './prompt.js';
import { generatedCasesSchema, type TestCase } from './schemas.js';
import { UsageTracker, type AIProvider, type AIUsage } from './types.js';

export interface GenerateOptions {
  context?: PromptContext;
  /** Extra attempts after an invalid answer. Default 2, so up to 3 attempts. */
  maxRetries?: number;
  /** Let the model review its own valid draft once. Default true. */
  selfReview?: boolean;
  /** Low keeps the cases predictable. Default 0.2. */
  temperature?: number;
  /** Adds this call's usage into a run-wide total. */
  usage?: UsageTracker;
}

export interface GenerateResult {
  ticket: string;
  cases: TestCase[];
  /** Calls it took to get a valid first draft. */
  attempts: number;
  /** True when the self-review pass produced the final cases. */
  reviewed: boolean;
  /** Why the review was skipped or ignored, when it was. */
  reviewNote?: string;
  usage: AIUsage;
  promptVersion: string;
}

/** The AI never produced a valid answer within the allowed attempts. */
export class GenerationError extends Error {
  readonly ticket: string;
  readonly attempts: number;
  readonly problems: string[];

  constructor(ticket: string, attempts: number, problems: string[]) {
    super(
      `Could not get valid test cases for ${ticket} after ${attempts} attempt(s): ` +
        problems.slice(0, 3).join(' '),
    );
    this.name = 'GenerationError';
    this.ticket = ticket;
    this.attempts = attempts;
    this.problems = problems;
  }
}

type Parsed = { ok: true; cases: TestCase[] } | { ok: false; problems: string[] };

/** Turns an AI answer into validated cases, or a list of what is wrong with it. */
function parseAnswer(text: string, truncated: boolean, ticketKey: string): Parsed {
  if (truncated) {
    return {
      ok: false,
      problems: ['The answer was cut off by the length limit. Return fewer, more concise cases.'],
    };
  }

  let data: unknown;
  try {
    data = extractJson(text);
  } catch (error) {
    const reason = error instanceof JsonExtractionError ? error.message : 'The answer is not JSON.';
    return { ok: false, problems: [`${reason} Reply with a single JSON object only.`] };
  }

  const result = generatedCasesSchema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'answer'}: ${issue.message}`,
    );
    return { ok: false, problems };
  }

  // The ticket is known, so set it and the numbering ourselves instead of trusting the model.
  const cases = result.data.cases.map((testCase, index) => ({
    ...testCase,
    id: `TC-${index + 1}`,
    ticket: ticketKey,
  }));
  return { ok: true, cases };
}

/**
 * Generates validated test cases for one ticket.
 * Retries with the validation errors when the answer is wrong, then lets the model
 * review its own draft once. The review never replaces a good draft with a bad one.
 */
export async function generateTestCases(
  provider: AIProvider,
  ticket: Ticket,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const context = options.context ?? {};
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const temperature = options.temperature ?? 0.2;
  const tracker = new UsageTracker();

  const ask = async (built: BuiltPrompt) => {
    const response = await provider.generate({
      system: built.system,
      prompt: built.prompt,
      json: true,
      temperature,
    });
    tracker.add(response.usage);
    options.usage?.add(response.usage);
    return response;
  };

  const original = buildGenerationPrompt(ticket, context);
  let request = original;
  let lastProblems: string[] = [];
  let cases: TestCase[] | undefined;
  let attempts = 0;
  let lastDraftJson = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;
    const response = await ask(request);
    const parsed = parseAnswer(response.text, response.truncated, ticket.key);

    if (parsed.ok) {
      cases = parsed.cases;
      lastDraftJson = JSON.stringify({ cases });
      break;
    }

    lastProblems = parsed.problems;
    request = buildRepairPrompt(original, response.text, parsed.problems);
  }

  if (!cases) {
    throw new GenerationError(ticket.key, attempts, lastProblems);
  }

  let reviewed = false;
  let reviewNote: string | undefined;

  if (options.selfReview ?? true) {
    try {
      const response = await ask(buildReviewPrompt(ticket, lastDraftJson, context));
      const parsed = parseAnswer(response.text, response.truncated, ticket.key);
      if (parsed.ok) {
        cases = parsed.cases;
        reviewed = true;
      } else {
        reviewNote = `The review answer was invalid, so the first draft was kept: ${parsed.problems[0]}`;
      }
    } catch (error) {
      if (!(error instanceof AIError)) throw error;
      reviewNote = `The review could not run, so the first draft was kept: ${error.message}`;
    }
  } else {
    reviewNote = 'Self-review is turned off.';
  }

  return {
    ticket: ticket.key,
    cases,
    attempts,
    reviewed,
    ...(reviewNote !== undefined && { reviewNote }),
    usage: tracker.total,
    promptVersion: PROMPT_VERSION,
  };
}
