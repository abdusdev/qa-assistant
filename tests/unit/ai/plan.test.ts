import { describe, expect, it } from 'vitest';
import { FakeAIProvider } from '../../../src/ai/fake.js';
import { generateTestCases } from '../../../src/ai/generate.js';
import { buildGenerationPrompt, buildReviewPrompt } from '../../../src/ai/prompt.js';
import { generatedCasesSchema } from '../../../src/ai/schemas.js';
import type { Ticket } from '../../../src/jira/ticket.js';

const ticket: Ticket = {
  key: 'SHP-4103',
  url: 'https://example.atlassian.net/browse/SHP-4103',
  summary: 'Order can be shipped after the Ship To address changes',
  type: 'Bug',
  status: 'Review',
  description:
    'When the Ship To address changes the old rates stay available and the user can ship the ' +
    'order. Shipping should be blocked until new rates are fetched and a rate is selected.',
  labels: [],
  fixVersions: [],
  comments: [],
};

const caseJson = (n: number, covers?: string[]) => ({
  id: `TC-${n}`,
  ticket: 'SHP-4103',
  flow_step: 'Failures',
  title: `Shipping is blocked in situation number ${n}`,
  type: 'ui',
  priority: 'high',
  steps: ['Fetch rates', 'Change the address', 'Click Ship'],
  expected: 'Shipping is blocked and a warning is shown',
  ...(covers && { covers }),
});

const answer = (plan: { id: string; behaviour: string }[], ...cases: object[]) =>
  JSON.stringify({ plan, cases });

describe('plan in the prompt', () => {
  it('asks for the plan first and a case for each item', () => {
    const { system } = buildGenerationPrompt(ticket);

    expect(system).toContain('## Plan first');
    expect(system).toContain('"plan"');
    expect(system).toContain('"covers"');
  });

  it('asks the review to find plan items without a case', () => {
    const { prompt } = buildReviewPrompt(ticket, '{"plan":[],"cases":[]}');

    expect(prompt).toContain('a plan item that no case covers');
  });
});

describe('plan in the answer', () => {
  it('accepts an answer with no plan, as older answers had none', () => {
    const parsed = generatedCasesSchema.parse({ cases: [caseJson(1)] });

    expect(parsed.plan).toEqual([]);
    expect(parsed.cases[0]?.covers).toBeUndefined();
  });

  it('keeps the plan and the items each case covers', async () => {
    const plan = [
      { id: 'B1', behaviour: 'Rates are cleared when the address changes' },
      { id: 'B2', behaviour: 'Shipping is blocked until new rates are selected' },
    ];
    const ai = new FakeAIProvider({
      replies: [answer(plan, caseJson(1, ['B1']), caseJson(2, ['B2', 'B1']))],
    });

    const result = await generateTestCases(ai, ticket, { selfReview: false });

    expect(result.plan).toEqual({ items: plan, uncovered: [] });
    expect(result.cases.map((c) => c.covers)).toEqual([['B1'], ['B2', 'B1']]);
  });

  it('lists a planned behaviour that no case covers', async () => {
    const plan = [
      { id: 'B1', behaviour: 'Rates are cleared' },
      { id: 'B2', behaviour: 'Name edits keep the rates' },
      { id: 'B3', behaviour: 'An open return is cleared too' },
    ];
    const ai = new FakeAIProvider({ replies: [answer(plan, caseJson(1, ['B1']))] });

    const result = await generateTestCases(ai, ticket, { selfReview: false });

    expect(result.plan.uncovered).toEqual(['B2', 'B3']);
  });

  it('numbers the plan again and drops a cover that is not in it', async () => {
    const plan = [
      { id: 'X7', behaviour: 'First behaviour' },
      { id: 'X9', behaviour: 'Second behaviour' },
    ];
    const ai = new FakeAIProvider({
      replies: [answer(plan, caseJson(1, ['X9', 'B99', 'X9']), caseJson(2, ['X7']))],
    });

    const result = await generateTestCases(ai, ticket, { selfReview: false });

    expect(result.plan.items.map((i) => i.id)).toEqual(['B1', 'B2']);
    expect(result.cases.map((c) => c.covers)).toEqual([['B2'], ['B1']]);
  });

  it('keeps the first plan when the review answer leaves the plan out', async () => {
    const plan = [{ id: 'B1', behaviour: 'Rates are cleared' }];
    const first = answer(plan, caseJson(1, ['B1']));
    const review = JSON.stringify({ cases: [caseJson(1, ['B1'])] });
    const ai = new FakeAIProvider({ replies: [first, review] });

    const result = await generateTestCases(ai, ticket);

    expect(result.reviewed).toBe(true);
    expect(result.plan.items).toEqual(plan);
  });

  it('sends the plan to the review with the draft', async () => {
    const plan = [{ id: 'B1', behaviour: 'Rates are cleared' }];
    const ai = new FakeAIProvider({
      replies: [answer(plan, caseJson(1, ['B1'])), answer(plan, caseJson(1, ['B1']))],
    });

    await generateTestCases(ai, ticket);

    expect(ai.calls[1]?.prompt).toContain('Rates are cleared');
    expect(ai.calls[1]?.prompt).toContain('"covers":["B1"]');
  });
});
