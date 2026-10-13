import { describe, expect, it } from 'vitest';
import { parseRoute } from '../../../web/src/hooks-route.js';
import type { ApiCase, ApiJob, ApiRun } from '../../../web/src/lib/types.js';
import {
  buildRequest,
  emptyForm,
  filterCases,
  formProblem,
  formatDuration,
  groupCases,
  isFinished,
  progressText,
  viewOfJob,
  viewOfRun,
} from '../../../web/src/lib/view.js';

const apiCase = (overrides: Partial<ApiCase> = {}): ApiCase => ({
  id: 'TC-1',
  ticket: 'SHP-1',
  flow_step: 'Happy path',
  title: 'Rates are cleared when the destination changes',
  type: 'ui',
  priority: 'high',
  preconditions: [],
  steps: ['Open the order', 'Change the destination'],
  expected: 'The old rates are marked outdated',
  sources: [],
  assumptions: [],
  depends_on: [],
  grounding: 'grounded',
  ...overrides,
});

const steps = [
  { order: 2, name: 'Failures', description: 'What goes wrong', caseIds: ['TC-2'] },
  { order: 1, name: 'Happy path', description: 'The normal journey', caseIds: ['TC-1'] },
];

describe('formProblem and buildRequest', () => {
  it('asks for a value, in the words of the mode', () => {
    expect(formProblem({ ...emptyForm, value: '  ' })).toBe('Enter a ticket key.');
    expect(formProblem({ ...emptyForm, mode: 'sprint', value: '' })).toBe(
      'Enter the name of a sprint.',
    );
    expect(formProblem({ ...emptyForm, mode: 'epic', value: '' })).toBe(
      'Enter the key of an epic.',
    );
  });

  it('checks the ticket limit', () => {
    const form = { ...emptyForm, value: 'SHP-1' };

    expect(formProblem({ ...form, max: '0' })).toContain('1 to 200');
    expect(formProblem({ ...form, max: '201' })).toContain('1 to 200');
    expect(formProblem({ ...form, max: '2.5' })).toContain('1 to 200');
    expect(formProblem({ ...form, max: 'abc' })).toContain('1 to 200');
    expect(formProblem({ ...form, max: '50' })).toBeUndefined();
    expect(formProblem(form)).toBeUndefined();
  });

  it('sends only what was filled in', () => {
    expect(buildRequest({ ...emptyForm, value: ' SHP-4103 ' })).toEqual({
      mode: 'ticket',
      value: 'SHP-4103',
    });
  });

  it('never insists on code context: it sends only an explicit no', () => {
    const on = buildRequest({ ...emptyForm, value: 'SHP-1', useCodeContext: true });
    const off = buildRequest({ ...emptyForm, value: 'SHP-1', useCodeContext: false });

    expect(on).not.toHaveProperty('useCodeContext');
    expect(off).toMatchObject({ useCodeContext: false });
  });

  it('splits the filters on commas and drops empty parts', () => {
    const request = buildRequest({
      ...emptyForm,
      mode: 'sprint',
      value: 'SN - Sprint 45',
      types: 'Story, Bug,, ',
      statuses: 'Review',
      max: '25',
      useCodeContext: false,
      selfReview: false,
    });

    expect(request).toEqual({
      mode: 'sprint',
      value: 'SN - Sprint 45',
      filters: { types: ['Story', 'Bug'], statuses: ['Review'] },
      max: 25,
      useCodeContext: false,
      selfReview: false,
    });
  });

  it('leaves the filters out when both are empty', () => {
    expect(buildRequest({ ...emptyForm, value: 'SHP-1', types: ' , ' })).not.toHaveProperty(
      'filters',
    );
  });
});

describe('progress', () => {
  const progress = (stage: string, total: number, done: number) => ({
    stage,
    total,
    done,
    tickets: [],
  });

  it('says how far a run is once the tickets are known', () => {
    expect(progressText({ status: 'running', progress: progress('generating', 5, 2) })).toBe(
      'Writing test cases: 2 of 5 tickets',
    );
    expect(progressText({ status: 'running', progress: progress('generating', 1, 0) })).toBe(
      'Writing test cases: 0 of 1 ticket',
    );
  });

  it('says only the stage before the tickets are known, and waiting when queued', () => {
    expect(progressText({ status: 'running', progress: progress('resolving', 0, 0) })).toBe(
      'Finding the tickets',
    );
    expect(progressText({ status: 'queued', progress: progress('queued', 0, 0) })).toBe(
      'Waiting in the queue',
    );
  });

  it('knows which statuses are final', () => {
    expect(['done', 'failed', 'cancelled'].every((s) => isFinished(s as never))).toBe(true);
    expect(isFinished('queued')).toBe(false);
    expect(isFinished('running')).toBe(false);
  });

  it('writes a duration in seconds and minutes', () => {
    expect(formatDuration(400)).toBe('0 s');
    expect(formatDuration(3_400)).toBe('3 s');
    expect(formatDuration(95_000)).toBe('1 min 35 s');
    expect(formatDuration(-5)).toBe('0 s');
  });
});

describe('groupCases', () => {
  it('follows the flow order and leaves out deleted cases', () => {
    const groups = groupCases(
      [apiCase(), apiCase({ id: 'TC-2' }), apiCase({ id: 'TC-3', state: 'deleted' })],
      [...steps, { order: 3, name: 'Regression', description: '', caseIds: ['TC-3'] }],
    );

    expect(groups.map((g) => [g.name, g.cases.map((c) => c.id)])).toEqual([
      ['Happy path', ['TC-1']],
      ['Failures', ['TC-2']],
    ]);
  });

  it('puts a case that no step lists in a final group so it does not disappear', () => {
    const groups = groupCases([apiCase(), apiCase({ id: 'TC-9' })], steps);

    expect(groups.at(-1)).toMatchObject({ name: 'Other' });
    expect(groups.at(-1)?.cases.map((c) => c.id)).toEqual(['TC-9']);
  });

  it('shows a case once even when two steps list it', () => {
    const groups = groupCases(
      [apiCase()],
      [
        { order: 1, name: 'First', description: '', caseIds: ['TC-1'] },
        { order: 2, name: 'Second', description: '', caseIds: ['TC-1'] },
      ],
    );

    expect(groups).toHaveLength(1);
  });
});

describe('views', () => {
  const job = (overrides: Partial<ApiJob> = {}): ApiJob => ({
    id: 'j1',
    status: 'done',
    input: { mode: 'list', value: 'SHP-1 SHP-2' },
    createdAt: '2026-10-12T10:00:00Z',
    cancelRequested: false,
    progress: { stage: 'finished', total: 2, done: 2, tickets: [] },
    result: {
      cases: [apiCase(), apiCase({ id: 'TC-2', ticket: 'SHP-2', grounding: 'assumed' })],
      flow: { steps },
      flowSource: 'ai',
      tickets: [
        { ticket: 'SHP-1', status: 'ok', cases: 1 },
        { ticket: 'SHP-2', status: 'ok', cases: 1 },
        { ticket: 'SHP-3', status: 'failed', cases: 0, error: 'Ticket SHP-3 was not found (404).' },
      ],
      warnings: ['SHP-2 has too little detail.'],
      grounding: { grounded: 1, partly: 0, assumed: 1 },
      usage: { totalTokens: 100 },
      calls: 3,
      durationMs: 1200,
    },
    ...overrides,
  });

  it('shows the grouped cases, the notes and the grounding of a finished job', () => {
    const view = viewOfJob(job());

    expect(view?.groups.map((g) => g.name)).toEqual(['Happy path', 'Failures']);
    expect(view?.warnings).toEqual(['SHP-2 has too little detail.']);
    expect(view?.grounding).toEqual({ grounded: 1, partly: 0, assumed: 1 });
  });

  it('lists tickets that failed, so they are not hidden behind the ones that worked', () => {
    expect(viewOfJob(job())?.problems).toEqual([
      { ticket: 'SHP-3', message: 'Ticket SHP-3 was not found (404).' },
    ]);
  });

  it('has no view until the job has a result', () => {
    expect(viewOfJob(job({ status: 'running', result: undefined }))).toBeUndefined();
  });

  it('shows a saved run the same way, without its deleted cases', () => {
    const run: ApiRun = {
      id: 'r1',
      createdAt: '2026-10-12T10:00:00Z',
      finishedAt: '2026-10-12T10:01:00Z',
      status: 'completed',
      inputMode: 'ticket',
      inputValue: 'SHP-1',
      model: 'demo',
      totalTokens: 10,
      caseCount: 1,
      error: null,
      warnings: [],
      calls: 1,
      durationMs: 1000,
      flow: [{ position: 0, name: 'Happy path', description: '', caseCodes: ['TC-1', 'TC-2'] }],
      cases: [apiCase({ state: 'edited' }), apiCase({ id: 'TC-2', state: 'deleted' })],
      tickets: [
        {
          ticket: 'SHP-1',
          status: 'ok',
          cases: 1,
          model: 'demo',
          cached: false,
          error: null,
          detail: null,
        },
        {
          ticket: 'SHP-2',
          status: 'skipped',
          cases: 0,
          model: null,
          cached: false,
          error: null,
          detail: null,
        },
      ],
    };

    const view = viewOfRun(run);

    expect(view.groups[0]?.cases.map((c) => c.id)).toEqual(['TC-1']);
    expect(view.grounding.grounded).toBe(1);
    expect(view.problems).toEqual([{ ticket: 'SHP-2', message: 'It was skipped.' }]);
  });
});

describe('filterCases', () => {
  const cases = [
    apiCase(),
    apiCase({ id: 'TC-2', ticket: 'SHP-2', title: 'Shipping is blocked', steps: ['Click Ship'] }),
  ];

  it('filters by ticket and by text, in any letter case', () => {
    expect(filterCases(cases, { ticket: 'SHP-2' }).map((c) => c.id)).toEqual(['TC-2']);
    expect(filterCases(cases, { text: 'BLOCKED' }).map((c) => c.id)).toEqual(['TC-2']);
    expect(filterCases(cases, { text: 'click ship' }).map((c) => c.id)).toEqual(['TC-2']);
    expect(filterCases(cases, { ticket: 'SHP-1', text: 'blocked' })).toEqual([]);
    expect(filterCases(cases, { text: '  ' })).toHaveLength(2);
  });
});

describe('parseRoute', () => {
  it('reads jobs and runs from the address and defaults to the home page', () => {
    expect(parseRoute('#/jobs/abc-123')).toEqual({ kind: 'job', id: 'abc-123' });
    expect(parseRoute('#/runs/7b0c')).toEqual({ kind: 'run', id: '7b0c' });
    expect(parseRoute('#/jobs/a%20b')).toEqual({ kind: 'job', id: 'a b' });
    expect(parseRoute('')).toEqual({ kind: 'home' });
    expect(parseRoute('#/')).toEqual({ kind: 'home' });
    expect(parseRoute('#/jobs')).toEqual({ kind: 'home' });
    expect(parseRoute('#/unknown/1')).toEqual({ kind: 'home' });
  });
});
