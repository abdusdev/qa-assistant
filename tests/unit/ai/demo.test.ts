import { describe, expect, it } from 'vitest';
import { DemoAIProvider } from '../../../src/ai/demo.js';
import { generateTestCases } from '../../../src/ai/generate.js';
import { generateFlow } from '../../../src/ai/flow.js';
import { testCaseSchema } from '../../../src/ai/schemas.js';
import { makeTicket } from '../pipeline/support.js';

describe('DemoAIProvider', () => {
  it('answers a ticket with valid, grounded cases', async () => {
    const ticket = makeTicket('SHP-7', { summary: 'Reprint the label of a shipment' });

    const result = await generateTestCases(new DemoAIProvider(), ticket);

    expect(result.cases.map((c) => c.id)).toEqual(['TC-1', 'TC-2']);
    expect(result.cases.every((c) => c.ticket === 'SHP-7')).toBe(true);
    expect(result.cases[0]?.grounding).toBe('grounded');
    expect(result.cases[0]?.sources[0]?.quote).toBe('Reprint the label of a shipment');
    expect(result.plan.items).toHaveLength(2);
    expect(result.plan.uncovered).toEqual([]);
  });

  it('orders cases into a flow that holds every case once', async () => {
    const make = (id: string, ticket: string, title: string) =>
      testCaseSchema.parse({
        id,
        ticket,
        flow_step: 'Happy path',
        title,
        type: 'ui',
        priority: 'high',
        steps: ['Do the thing'],
        expected: 'It works',
      });

    const flow = await generateFlow(
      new DemoAIProvider(),
      [make('TC-1', 'SHP-1', 'First case title'), make('TC-2', 'SHP-2', 'Second case title')],
      {},
    );

    expect(flow.flow.steps.flatMap((s) => s.caseIds)).toEqual(['TC-1', 'TC-2']);
  });

  it('reports usage and says it is the demo model', async () => {
    const response = await new DemoAIProvider().generate({ prompt: 'anything' });

    expect(response.model).toBe('demo');
    expect(response.truncated).toBe(false);
    expect(response.usage.totalTokens).toBe(
      response.usage.inputTokens + response.usage.outputTokens,
    );
  });

  it('is deterministic', async () => {
    const ai = new DemoAIProvider();
    const request = {
      prompt: '<ticket key="SHP-1" type="Bug" status="Done">\nSummary: Same\n</ticket>',
    };

    expect((await ai.generate(request)).text).toBe((await ai.generate(request)).text);
  });
});
