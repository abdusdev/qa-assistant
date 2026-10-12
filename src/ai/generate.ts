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
import {
  assessTicketDetail,
  buildEvidence,
  groundCase,
  mergeDetail,
  type DetailAssessment,
} from './grounding.js';
import {
  generatedCasesSchema,
  type PlanItem,
  type TestCase,
  type TicketDetail,
} from './schemas.js';
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
  /** The model that answered the last call, which can differ per ticket when models fall back. */
  model: string;
  /** Whether the ticket says enough to write reliable cases, and what is missing if not. */
  detail: DetailAssessment;
  /** What the model planned to test, and the planned behaviours that no case covers. */
  plan: { items: PlanItem[]; uncovered: string[] };
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

interface Plan {
  items: PlanItem[];
  uncovered: string[];
}

type Parsed =
  | { ok: true; cases: TestCase[]; detail: TicketDetail | undefined; plan: Plan }
  | { ok: false; problems: string[] };

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
  // Dependencies are rewritten to the new numbers, and unknown or self references are dropped.
  const newIdByOld = new Map<string, string>();
  result.data.cases.forEach((testCase, index) => newIdByOld.set(testCase.id, `TC-${index + 1}`));

  const cases = result.data.cases.map((testCase, index) => {
    const id = `TC-${index + 1}`;
    const dependsOn = testCase.depends_on
      .map((old) => newIdByOld.get(old))
      .filter((dep): dep is string => dep !== undefined && dep !== id);
    return { ...testCase, id, ticket: ticketKey, depends_on: [...new Set(dependsOn)] };
  });

  // The plan is renumbered B1..n too. A case may only cover items that exist, and a planned
  // behaviour that no case covers is reported, not hidden.
  const newPlanId = new Map<string, string>();
  const items = result.data.plan.map((item, index) => {
    newPlanId.set(item.id, `B${index + 1}`);
    return { id: `B${index + 1}`, behaviour: item.behaviour };
  });
  const covered = new Set<string>();
  const withCoverage = cases.map((testCase) => {
    const covers = [
      ...new Set(
        (testCase.covers ?? [])
          .map((old) => newPlanId.get(old))
          .filter((id): id is string => id !== undefined),
      ),
    ];
    covers.forEach((id) => covered.add(id));
    return { ...testCase, covers };
  });
  const uncovered = items.filter((item) => !covered.has(item.id)).map((item) => item.id);

  return {
    ok: true,
    cases: withCoverage,
    detail: result.data.detail,
    plan: { items, uncovered },
  };
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

  let answeredBy = '';

  const ask = async (built: BuiltPrompt) => {
    const response = await provider.generate({
      system: built.system,
      prompt: built.prompt,
      json: true,
      temperature,
    });
    tracker.add(response.usage);
    options.usage?.add(response.usage);
    answeredBy = response.model;
    return response;
  };

  const evidence = buildEvidence(ticket, context);
  const grounded = (items: TestCase[]) => items.map((item) => groundCase(item, evidence));
  let modelDetail: TicketDetail | undefined;
  let plan: Plan = { items: [], uncovered: [] };

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
      cases = grounded(parsed.cases);
      modelDetail = parsed.detail;
      plan = parsed.plan;
      lastDraftJson = JSON.stringify({ detail: modelDetail, plan: plan.items, cases });
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
        cases = grounded(parsed.cases);
        modelDetail = parsed.detail ?? modelDetail;
        // A review that dropped the plan keeps the first one rather than losing it.
        if (parsed.plan.items.length > 0) plan = parsed.plan;
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
    model: answeredBy,
    detail: mergeDetail(assessTicketDetail(ticket), modelDetail),
    plan,
  };
}
