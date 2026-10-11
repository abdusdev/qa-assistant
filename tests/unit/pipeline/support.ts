import { AIError } from '../../../src/ai/errors.js';
import type { AIProvider, AIRequest, AIResponse } from '../../../src/ai/types.js';
import type { Ticket } from '../../../src/jira/ticket.js';

export const makeTicket = (key: string, overrides: Partial<Ticket> = {}): Ticket => ({
  key,
  url: `https://example.atlassian.net/browse/${key}`,
  summary: `Summary of ${key}`,
  type: 'Story',
  status: 'Done',
  description:
    `Description of ${key}. The seller selects several orders, chooses a courier rate for each one and ` +
    'creates the shipments in one action. Orders without a rate are skipped, and the result summary lists ' +
    'every skipped order with the reason so the seller can fix it and try again.',
  labels: [],
  fixVersions: [],
  comments: [],
  ...overrides,
});

export interface CaseSpec {
  title: string;
  expected: string;
  type?: string;
  flow_step?: string;
  sources?: { from: string; quote: string }[];
  assumptions?: string[];
  preconditions?: string[];
  /** Ids within the ticket's own answer, such as TC-1. */
  depends_on?: string[];
}

export interface ScriptOptions {
  /** Cases generated per ticket. Default 2. */
  casesPerTicket?: number;
  /** Full control over the cases of a ticket. */
  casesFor?: (key: string) => CaseSpec[];
  /** These tickets always get an answer that is not JSON. */
  garbageFor?: string[];
  /** These tickets make the provider throw. */
  throwFor?: Record<string, AIError>;
  /** These tickets fail only on the self-review call. */
  reviewThrowFor?: Record<string, AIError>;
  /** The ticket-detail verdict the model gives per ticket. Default: enough detail. */
  detailFor?: (key: string) => { sufficient: boolean; missing: string[] } | undefined;
  /** What the flow request gets back. Default "ok". */
  flow?: 'ok' | 'incomplete' | 'garbage' | 'throw';
  /** Pretend delay per ticket in milliseconds. */
  delayMs?: Record<string, number>;
}

export interface ScriptedAI extends AIProvider {
  readonly requests: AIRequest[];
  /** Number of generation calls (first answers, retries, reviews) per ticket. */
  callsFor(key: string): number;
  readonly flowCalls: number;
  readonly peakInFlight: number;
}

const ticketKeyOf = (prompt: string) => /<ticket key="([^"]+)"/.exec(prompt)?.[1];
const numberOf = (key: string) => Number(/(\d+)$/.exec(key)?.[1] ?? 0);

/** Unique-looking wording, so different tickets are never mistaken for duplicates. */
function defaultCases(key: string, count: number): CaseSpec[] {
  const num = numberOf(key);
  return Array.from({ length: count }, (_, i) => ({
    title: `Check alpha${num}k${i} beta${num}k${i} scenario`,
    expected: `Gamma${num}k${i} delta${num}k${i} holds`,
    flow_step: i % 2 === 0 ? 'Happy path' : 'Failures',
  }));
}

function casesAnswer(
  key: string,
  specs: CaseSpec[],
  detail?: { sufficient: boolean; missing: string[] },
): string {
  return JSON.stringify({
    ...(detail && { detail }),
    cases: specs.map((spec, i) => ({
      id: `TC-${i + 1}`,
      ticket: key,
      flow_step: spec.flow_step ?? 'Happy path',
      title: spec.title,
      type: spec.type ?? 'ui',
      priority: 'medium',
      steps: ['Do the first thing', 'Do the second thing'],
      expected: spec.expected,
      ...(spec.sources && { sources: spec.sources }),
      ...(spec.assumptions && { assumptions: spec.assumptions }),
      ...(spec.preconditions && { preconditions: spec.preconditions }),
      ...(spec.depends_on && { depends_on: spec.depends_on }),
    })),
  });
}

function flowAnswer(prompt: string, mode: 'ok' | 'incomplete'): string {
  const ids = [...prompt.matchAll(/^(TC-\d+) \|/gm)].map((m) => m[1] as string);
  if (mode === 'incomplete') {
    return JSON.stringify({
      steps: [{ order: 1, name: 'Happy path', description: '', caseIds: ids.slice(0, 1) }],
    });
  }
  const half = Math.ceil(ids.length / 2);
  return JSON.stringify({
    steps: [
      { order: 2, name: 'Failures', description: 'Things that go wrong', caseIds: ids.slice(half) },
      {
        order: 1,
        name: 'Happy path',
        description: 'The normal journey',
        caseIds: ids.slice(0, half),
      },
    ].filter((step) => step.caseIds.length > 0),
  });
}

/**
 * An AI stand-in that answers by what the prompt asks for: cases for a ticket, a review of a
 * draft, or the flow of a run. Safe to use with parallel tickets, because it never depends on
 * the order calls arrive in.
 */
export function scriptedAI(options: ScriptOptions = {}): ScriptedAI {
  const requests: AIRequest[] = [];
  const perTicket = new Map<string, number>();
  let flowCalls = 0;
  let inFlight = 0;
  let peak = 0;

  const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
  const respond = (text: string): AIResponse => ({
    text,
    usage,
    model: 'scripted',
    truncated: false,
  });

  return {
    name: 'scripted',
    requests,
    callsFor: (key) => perTicket.get(key) ?? 0,
    get flowCalls() {
      return flowCalls;
    },
    get peakInFlight() {
      return peak;
    },

    async generate(request: AIRequest): Promise<AIResponse> {
      requests.push(request);
      inFlight++;
      peak = Math.max(peak, inFlight);

      try {
        const key = ticketKeyOf(request.prompt);

        if (key === undefined) {
          flowCalls++;
          const mode = options.flow ?? 'ok';
          if (mode === 'throw') throw new AIError('server_error', 'flow service down');
          if (mode === 'garbage') return respond('I could not order these.');
          return respond(flowAnswer(request.prompt, mode));
        }

        perTicket.set(key, (perTicket.get(key) ?? 0) + 1);
        const wait = options.delayMs?.[key];
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));

        const reviewFailure = request.prompt.includes('<draft>')
          ? options.reviewThrowFor?.[key]
          : undefined;
        if (reviewFailure) throw reviewFailure;

        const failure = options.throwFor?.[key];
        if (failure) throw failure;
        if (options.garbageFor?.includes(key)) return respond('Sorry, I cannot do that.');

        const specs = options.casesFor?.(key) ?? defaultCases(key, options.casesPerTicket ?? 2);
        return respond(casesAnswer(key, specs, options.detailFor?.(key)));
      } finally {
        inFlight--;
      }
    },
  };
}
