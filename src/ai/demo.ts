import type { AIProvider, AIRequest, AIResponse } from './types.js';

const approxTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

const TICKET_KEY = /<ticket key="([^"]+)"/;
const SUMMARY = /^Summary:\s*(.+)$/m;
const FLOW_LINE = /^(TC-\d+) \|/gm;

/**
 * An offline stand-in for a real model, used when AI_PROVIDER=fake. It answers every kind of
 * request the pipeline makes with a small, valid, predictable result built from the ticket it is
 * shown, so the whole system can run end to end with no network and no cost.
 *
 * It does not understand anything. The cases it returns only repeat the ticket's own summary, so
 * they are never worth reading as test cases.
 */
export class DemoAIProvider implements AIProvider {
  readonly name = 'fake';

  async generate(request: AIRequest): Promise<AIResponse> {
    const text = this.answer(request);
    const inputTokens = approxTokens(`${request.system ?? ''}${request.prompt}`);
    const outputTokens = approxTokens(text);
    return {
      text,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      model: 'demo',
      truncated: false,
    };
  }

  private answer(request: AIRequest): string {
    const key = TICKET_KEY.exec(request.prompt)?.[1];
    if (key === undefined) return this.flowAnswer(request.prompt);

    const summary = (SUMMARY.exec(request.prompt)?.[1] ?? 'the ticket').trim().slice(0, 140);
    return JSON.stringify({
      detail: { sufficient: true, missing: [] },
      plan: [
        { id: 'B1', behaviour: `The behaviour described in the summary of ${key}` },
        { id: 'B2', behaviour: `The behaviour fails safely for ${key}` },
      ],
      cases: [
        {
          id: 'TC-1',
          ticket: key,
          flow_step: 'Happy path',
          title: `Check the main behaviour of ${key}`,
          type: 'ui',
          priority: 'high',
          preconditions: ['The environment is available'],
          steps: ['Open the feature', 'Perform the action from the ticket'],
          expected: `The behaviour described in "${summary}" works`,
          sources: [{ from: 'ticket', quote: summary }],
          assumptions: [],
          depends_on: [],
          covers: ['B1'],
        },
        {
          id: 'TC-2',
          ticket: key,
          flow_step: 'Failures',
          title: `Check that "${summary}" fails safely for ${key}`,
          type: 'ui',
          priority: 'medium',
          preconditions: ['The environment is available'],
          steps: ['Open the feature', `Perform the action for "${summary}" with invalid input`],
          expected: `A clear message is shown for "${summary}" and nothing is changed`,
          sources: [{ from: 'inferred', quote: '' }],
          assumptions: ['The message wording is not given in the ticket'],
          depends_on: [],
          covers: ['B2'],
        },
      ],
    });
  }

  private flowAnswer(prompt: string): string {
    const ids = [...prompt.matchAll(FLOW_LINE)].map((match) => match[1] as string);
    return JSON.stringify({
      steps: [
        {
          order: 1,
          name: 'Happy path',
          description: 'The normal journey works',
          caseIds: ids,
        },
      ],
    });
  }
}
