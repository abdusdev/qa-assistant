import { describe, expect, it } from 'vitest';
import {
  checkFlow,
  flowSchema,
  generatedCasesSchema,
  testCaseSchema,
} from '../../../src/ai/schemas.js';

const validCase = {
  id: 'TC-1',
  ticket: 'SHP-4103',
  flow_step: 'Failures',
  title: 'Shipping is blocked when the address changed and rates were not refetched',
  type: 'ui',
  priority: 'high',
  steps: ['Fetch rates for the order', 'Change the Ship To address', 'Click Ship'],
  expected: 'Shipping is blocked and a warning asks the user to fetch rates again',
};

describe('testCaseSchema', () => {
  it('accepts a complete case', () => {
    expect(testCaseSchema.parse(validCase)).toEqual({
      ...validCase,
      sources: [],
      assumptions: [],
      preconditions: [],
      depends_on: [],
      grounding: 'assumed',
    });
  });

  it('accepts type and priority in any letter case', () => {
    const parsed = testCaseSchema.parse({ ...validCase, type: ' UI ', priority: 'High' });
    expect(parsed.type).toBe('ui');
    expect(parsed.priority).toBe('high');
  });

  it('trims surrounding spaces in text fields', () => {
    const parsed = testCaseSchema.parse({ ...validCase, title: '  A clear enough title  ' });
    expect(parsed.title).toBe('A clear enough title');
  });

  it.each([
    ['id', ''],
    ['ticket', ''],
    ['flow_step', '   '],
    ['title', 'abc'],
    ['expected', ''],
    ['type', 'e2e'],
    ['priority', 'urgent'],
    ['steps', []],
  ])('rejects an invalid %s', (field, value) => {
    expect(testCaseSchema.safeParse({ ...validCase, [field]: value }).success).toBe(false);
  });

  it('rejects a missing field and names it', () => {
    const withoutExpected: Record<string, unknown> = { ...validCase };
    delete withoutExpected.expected;

    const result = testCaseSchema.safeParse(withoutExpected);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['expected']);
  });

  it('rejects a blank step', () => {
    expect(
      testCaseSchema.safeParse({ ...validCase, steps: ['Open the order', '  '] }).success,
    ).toBe(false);
  });

  it.each([
    ['ticket', 'ticket'],
    ['acceptance_criteria', 'acceptance_criteria'],
    ['module_notes', 'module_notes'],
    ['past_cases', 'past_cases'],
    ['code_changes', 'code_changes'],
    ['Code changes', 'code_changes'],
    ['code-changes', 'code_changes'],
    ['Acceptance criteria', 'acceptance_criteria'],
    ['  Module Notes ', 'module_notes'],
    ['past case', 'past_cases'],
    ['code', 'code_changes'],
    ['comment', 'comment'],
    ['inferred', 'inferred'],
    ['something else', 'inferred'],
  ])('reads the source name "%s" as %s', (written, expected) => {
    const parsed = testCaseSchema.parse({
      ...validCase,
      sources: [{ from: written, quote: 'a quote' }],
    });

    expect(parsed.sources[0]?.from).toBe(expected);
  });

  it('rejects text that is far too long', () => {
    expect(testCaseSchema.safeParse({ ...validCase, title: 'x'.repeat(201) }).success).toBe(false);
    expect(testCaseSchema.safeParse({ ...validCase, expected: 'x'.repeat(1001) }).success).toBe(
      false,
    );
  });
});

describe('generatedCasesSchema', () => {
  it('accepts a list of cases', () => {
    const result = generatedCasesSchema.parse({ cases: [validCase, { ...validCase, id: 'TC-2' }] });
    expect(result.cases).toHaveLength(2);
  });

  it('rejects an empty list, a missing list and too many cases', () => {
    expect(generatedCasesSchema.safeParse({ cases: [] }).success).toBe(false);
    expect(generatedCasesSchema.safeParse({}).success).toBe(false);
    expect(
      generatedCasesSchema.safeParse({ cases: Array.from({ length: 41 }, () => validCase) })
        .success,
    ).toBe(false);
  });

  it('points at the case and field that are wrong', () => {
    const result = generatedCasesSchema.safeParse({
      cases: [validCase, { ...validCase, id: 'TC-2', expected: '' }],
    });

    expect(result.error?.issues[0]?.path).toEqual(['cases', 1, 'expected']);
  });
});

describe('flowSchema and checkFlow', () => {
  const cases = [{ id: 'TC-1' }, { id: 'TC-2' }, { id: 'TC-3' }];
  const flow = flowSchema.parse({
    steps: [
      { order: 1, name: 'Happy path', caseIds: ['TC-1'] },
      {
        order: 2,
        name: 'Failures',
        description: 'Things that go wrong',
        caseIds: ['TC-2', 'TC-3'],
      },
    ],
  });

  it('accepts a flow and defaults the description', () => {
    expect(flow.steps[0]?.description).toBe('');
    expect(flow.steps[1]?.description).toBe('Things that go wrong');
  });

  it('rejects a flow with no steps', () => {
    expect(flowSchema.safeParse({ steps: [] }).success).toBe(false);
  });

  it('finds no problems when every case is in exactly one step', () => {
    expect(checkFlow(flow, cases)).toEqual([]);
  });

  it('reports a case that is in no step', () => {
    const partial = flowSchema.parse({
      steps: [{ order: 1, name: 'Happy path', caseIds: ['TC-1', 'TC-2'] }],
    });

    expect(checkFlow(partial, cases)).toEqual(['TC-3 is not in any flow step.']);
  });

  it('reports a case that is in two steps', () => {
    const doubled = flowSchema.parse({
      steps: [
        { order: 1, name: 'Happy path', caseIds: ['TC-1', 'TC-2'] },
        { order: 2, name: 'Failures', caseIds: ['TC-2', 'TC-3'] },
      ],
    });

    expect(checkFlow(doubled, cases)).toEqual([
      'TC-2 appears in 2 flow steps. It must be in exactly one.',
    ]);
  });

  it('reports an unknown case id and a repeated order', () => {
    const odd = flowSchema.parse({
      steps: [
        { order: 1, name: 'Happy path', caseIds: ['TC-1', 'TC-2', 'TC-3'] },
        { order: 1, name: 'Failures', caseIds: ['TC-99'] },
      ],
    });

    expect(checkFlow(odd, cases)).toEqual([
      'Two flow steps have the order 1.',
      'Flow step "Failures" lists TC-99, which is not a known case.',
    ]);
  });
});
