import { describe, expect, it } from 'vitest';
import type { Flow, TestCase } from '../../../src/ai/schemas.js';
import { removeCrossTicketDuplicates } from '../../../src/pipeline/dedupe.js';
import { applyFlow, fallbackFlow } from '../../../src/pipeline/flow.js';

const testCase = (overrides: Partial<TestCase> = {}): TestCase => ({
  id: 'TC-1',
  ticket: 'SHP-1',
  flow_step: 'Happy path',
  title: 'Create shipments for all selected orders',
  type: 'ui',
  priority: 'high',
  steps: ['Select orders', 'Click Create'],
  expected: 'One shipment is created per selected order',
  ...overrides,
});

describe('removeCrossTicketDuplicates', () => {
  it('removes a near-identical case from a different ticket and names the one kept', () => {
    const first = testCase({ id: 'TC-1', ticket: 'SHP-1' });
    const second = testCase({ id: 'TC-2', ticket: 'SHP-2' });

    const { kept, removed } = removeCrossTicketDuplicates([first, second]);

    expect(kept).toEqual([first]);
    expect(removed).toEqual([{ removed: second, keptInstead: first }]);
  });

  it('never removes a case of the same ticket', () => {
    const cases = [testCase({ id: 'TC-1' }), testCase({ id: 'TC-2' })];

    expect(removeCrossTicketDuplicates(cases).kept).toHaveLength(2);
  });

  it('keeps cases of different types even when the wording matches', () => {
    const cases = [
      testCase({ id: 'TC-1', ticket: 'SHP-1', type: 'ui' }),
      testCase({ id: 'TC-2', ticket: 'SHP-2', type: 'api' }),
    ];

    expect(removeCrossTicketDuplicates(cases).kept).toHaveLength(2);
  });

  it('keeps cases that are only partly alike', () => {
    const cases = [
      testCase({ id: 'TC-1', ticket: 'SHP-1' }),
      testCase({
        id: 'TC-2',
        ticket: 'SHP-2',
        title: 'Create shipments for exactly 100 selected orders',
        expected: 'All 100 shipments are created and the summary shows 100',
      }),
    ];

    expect(removeCrossTicketDuplicates(cases).kept).toHaveLength(2);
  });

  it('honours a custom threshold', () => {
    const cases = [
      testCase({ id: 'TC-1', ticket: 'SHP-1' }),
      testCase({
        id: 'TC-2',
        ticket: 'SHP-2',
        title: 'Create shipments for the selected orders',
        expected: 'A shipment is created for each selected order',
      }),
    ];

    expect(removeCrossTicketDuplicates(cases, 0.99).kept).toHaveLength(2);
    expect(removeCrossTicketDuplicates(cases, 0.4).kept).toHaveLength(1);
  });

  it('compares with kept cases only, so a chain of near-copies collapses to one', () => {
    const cases = ['SHP-1', 'SHP-2', 'SHP-3'].map((ticket, i) =>
      testCase({ id: `TC-${i + 1}`, ticket }),
    );

    const { kept, removed } = removeCrossTicketDuplicates(cases);

    expect(kept.map((c) => c.ticket)).toEqual(['SHP-1']);
    expect(removed).toHaveLength(2);
  });

  it('returns nothing for no cases', () => {
    expect(removeCrossTicketDuplicates([])).toEqual({ kept: [], removed: [] });
  });
});

describe('fallbackFlow', () => {
  const withStep = (id: string, flow_step: string) => ({ id, flow_step });

  it('groups cases by their own step, usual steps first in their usual order', () => {
    const flow = fallbackFlow([
      withStep('TC-1', 'Failures'),
      withStep('TC-2', 'Happy path'),
      withStep('TC-3', 'Regression'),
      withStep('TC-4', 'Happy path'),
      withStep('TC-5', 'Selection'),
    ]);

    expect(flow.steps.map((s) => [s.order, s.name, s.caseIds])).toEqual([
      [1, 'Selection', ['TC-5']],
      [2, 'Happy path', ['TC-2', 'TC-4']],
      [3, 'Failures', ['TC-1']],
      [4, 'Regression', ['TC-3']],
    ]);
  });

  it('puts unusual step names after the usual ones, in first-seen order', () => {
    const flow = fallbackFlow([
      withStep('TC-1', 'Permissions'),
      withStep('TC-2', 'Happy path'),
      withStep('TC-3', 'Localisation'),
    ]);

    expect(flow.steps.map((s) => s.name)).toEqual(['Happy path', 'Permissions', 'Localisation']);
  });

  it('treats step names without regard to letter case and spacing', () => {
    const flow = fallbackFlow([withStep('TC-1', 'happy PATH'), withStep('TC-2', ' Happy path ')]);

    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0]).toMatchObject({ name: 'Happy path', caseIds: ['TC-1', 'TC-2'] });
  });

  it('gives a case without a step a step named Other', () => {
    const flow = fallbackFlow([withStep('TC-1', '   ')]);

    expect(flow.steps[0]?.name).toBe('Other');
  });

  it('returns no steps for no cases', () => {
    expect(fallbackFlow([])).toEqual({ steps: [] });
  });
});

describe('applyFlow', () => {
  const cases = [
    testCase({ id: 'TC-1', flow_step: 'Happy path' }),
    testCase({ id: 'TC-2', flow_step: 'Happy path' }),
    testCase({ id: 'TC-3', flow_step: 'Happy path' }),
  ];

  it('orders cases by the flow and renames their step to the flow step', () => {
    const flow: Flow = {
      steps: [
        { order: 2, name: 'Failures', description: '', caseIds: ['TC-1'] },
        { order: 1, name: 'Selection', description: '', caseIds: ['TC-3', 'TC-2'] },
      ],
    };

    const result = applyFlow(cases, flow);

    expect(result.map((c) => [c.id, c.flow_step])).toEqual([
      ['TC-3', 'Selection'],
      ['TC-2', 'Selection'],
      ['TC-1', 'Failures'],
    ]);
  });

  it('keeps cases the flow does not mention, at the end', () => {
    const flow: Flow = {
      steps: [{ order: 1, name: 'Failures', description: '', caseIds: ['TC-2'] }],
    };

    expect(applyFlow(cases, flow).map((c) => c.id)).toEqual(['TC-2', 'TC-1', 'TC-3']);
  });

  it('ignores unknown ids and repeated ids', () => {
    const flow: Flow = {
      steps: [
        { order: 1, name: 'A', description: '', caseIds: ['TC-9', 'TC-1', 'TC-1'] },
        { order: 2, name: 'B', description: '', caseIds: ['TC-2', 'TC-3'] },
      ],
    };

    const result = applyFlow(cases, flow);

    expect(result.map((c) => c.id)).toEqual(['TC-1', 'TC-2', 'TC-3']);
    expect(result[0]?.flow_step).toBe('A');
  });

  it('does not change the input cases', () => {
    const flow: Flow = {
      steps: [{ order: 1, name: 'Renamed', description: '', caseIds: ['TC-1', 'TC-2', 'TC-3'] }],
    };

    applyFlow(cases, flow);

    expect(cases[0]?.flow_step).toBe('Happy path');
  });
});
