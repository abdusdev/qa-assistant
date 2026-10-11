import { extractJson, JsonExtractionError } from './json.js';
import { buildFlowPrompt, buildFlowRepairPrompt, type BuiltPrompt } from './prompt.js';
import { checkFlow, flowSchema, type Flow, type TestCase } from './schemas.js';
import { UsageTracker, type AIProvider, type AIUsage } from './types.js';

export interface FlowOptions {
  /** Extra attempts after an invalid answer. Default 2. */
  maxRetries?: number;
  temperature?: number;
  /** Adds this call's usage into a run-wide total. */
  usage?: UsageTracker;
}

export interface FlowResult {
  flow: Flow;
  attempts: number;
  usage: AIUsage;
}

/** The AI never produced a sound flow within the allowed attempts. */
export class FlowError extends Error {
  readonly attempts: number;
  readonly problems: string[];

  constructor(attempts: number, problems: string[]) {
    super(
      `Could not get a valid test flow after ${attempts} attempt(s): ${problems.slice(0, 3).join(' ')}`,
    );
    this.name = 'FlowError';
    this.attempts = attempts;
    this.problems = problems;
  }
}

type Parsed = { ok: true; flow: Flow } | { ok: false; problems: string[] };

function parseFlow(text: string, truncated: boolean, cases: TestCase[]): Parsed {
  if (truncated) {
    return { ok: false, problems: ['The answer was cut off by the length limit.'] };
  }

  let data: unknown;
  try {
    data = extractJson(text);
  } catch (error) {
    const reason = error instanceof JsonExtractionError ? error.message : 'The answer is not JSON.';
    return { ok: false, problems: [`${reason} Reply with a single JSON object only.`] };
  }

  const parsed = flowSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'answer'}: ${i.message}`),
    };
  }

  const problems = checkFlow(parsed.data, cases);
  if (problems.length > 0) return { ok: false, problems };

  // Use the order of the answer, but number the steps 1..n so the numbering is always clean.
  const steps = [...parsed.data.steps]
    .sort((a, b) => a.order - b.order)
    .map((step, index) => ({ ...step, order: index + 1 }));
  return { ok: true, flow: { steps } };
}

/**
 * Asks the model to put all cases of a run into one ordered flow, and checks that every
 * case sits in exactly one step. Throws FlowError when it cannot get a sound flow.
 */
export async function generateFlow(
  provider: AIProvider,
  cases: TestCase[],
  options: FlowOptions = {},
): Promise<FlowResult> {
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const tracker = new UsageTracker();

  const original = buildFlowPrompt(cases);
  let request: BuiltPrompt = original;
  let problems: string[] = [];
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;
    const response = await provider.generate({
      system: request.system,
      prompt: request.prompt,
      json: true,
      temperature: options.temperature ?? 0.1,
    });
    tracker.add(response.usage);
    options.usage?.add(response.usage);

    const parsed = parseFlow(response.text, response.truncated, cases);
    if (parsed.ok) {
      return { flow: parsed.flow, attempts, usage: tracker.total };
    }

    problems = parsed.problems;
    request = buildFlowRepairPrompt(original, response.text, parsed.problems);
  }

  throw new FlowError(attempts, problems);
}
