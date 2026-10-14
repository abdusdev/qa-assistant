import { describe, expect, it } from 'vitest';
import type { ReviewActivity, StoredCase, StoredRun, StoredTicket } from '../../../src/db/index.js';
import { parseBaseline } from '../../../src/pilot/baseline.js';
import {
  buildReport,
  recommend,
  renderReport,
  THRESHOLDS,
  type PilotRunInput,
} from '../../../src/pilot/report.js';

let counter = 0;

function makeCase(
  ticket: string,
  state: StoredCase['state'],
  options: Partial<StoredCase> = {},
): StoredCase {
  counter += 1;
  return {
    uid: `uid-${counter}`,
    runId: 'run',
    id: `TC-${counter}`,
    ticket,
    position: counter,
    flow_step: 'Happy path',
    title: `Case ${counter} for ${ticket}`,
    type: 'ui',
    priority: 'medium',
    steps: ['step'],
    expected: 'outcome',
    preconditions: [],
    assumptions: [],
    sources: [],
    depends_on: [],
    covers: [],
    grounding: [],
    state,
    origin: state === 'added' ? 'added' : 'generated',
    approved: false,
    updatedAt: new Date('2026-10-14T10:00:00Z'),
    ...options,
  } as StoredCase;
}

function makeTicket(key: string, options: Partial<StoredTicket> = {}): StoredTicket {
  return {
    ticket: key,
    position: 0,
    status: 'ok',
    cases: 0,
    attempts: 1,
    reviewed: true,
    cached: false,
    model: 'm',
    reviewNote: null,
    error: null,
    detail: null,
    plan: null,
    ...options,
  };
}

function makeRun(id: string, createdAt: string, options: Partial<StoredRun> = {}): StoredRun {
  return {
    id,
    createdAt: new Date(createdAt),
    finishedAt: new Date(createdAt),
    status: 'completed',
    inputMode: 'list',
    inputValue: 'SHP-1 SHP-2',
    promptVersion: 'v3',
    model: 'gemini-test',
    totalTokens: 0,
    caseCount: 0,
    error: null,
    filters: {},
    flowSource: 'ai',
    warnings: [],
    inputTokens: 1000,
    outputTokens: 500,
    calls: 4,
    estimatedCostUsd: 0.5,
    durationMs: 6 * 60_000,
    tickets: [],
    flow: [],
    cases: [],
    ...options,
  };
}

const noActivity: ReviewActivity = {
  firstChangeAt: null,
  lastChangeAt: null,
  people: [],
  editedFields: {},
  replaced: [],
};

/** Two tickets: SHP-1 has 4 AI cases (2 kept, 1 edited, 1 deleted) and 1 added; SHP-2 has 2 kept. */
function sampleRun(): PilotRunInput {
  const cases = [
    makeCase('SHP-1', 'generated', { approved: true }),
    makeCase('SHP-1', 'generated', { approved: true }),
    makeCase('SHP-1', 'edited', { approved: true }),
    makeCase('SHP-1', 'deleted', { approved: true }),
    makeCase('SHP-1', 'added', { title: 'Tax is added for orders to Canada', approved: true }),
    makeCase('SHP-2', 'generated'),
    makeCase('SHP-2', 'generated'),
  ];
  return {
    run: makeRun('run-1', '2026-10-14T09:00:00Z', {
      tickets: [
        makeTicket('SHP-1', { plan: { items: [], uncovered: ['Refund after partial ship'] } }),
        makeTicket('SHP-2', { detail: { sufficient: false, missing: ['Which couriers apply'] } }),
      ],
      cases,
    }),
    activity: {
      firstChangeAt: new Date('2026-10-14T10:00:00Z'),
      lastChangeAt: new Date('2026-10-14T10:45:00Z'),
      people: ['asha', 'qa'],
      editedFields: { expected: 1, title: 2 },
      replaced: [],
    },
  };
}

describe('buildReport case counts', () => {
  it('counts kept, edited, deleted, added and approved per ticket and in total', () => {
    const report = buildReport([sampleRun()]);

    expect(report.tickets.find((t) => t.ticket === 'SHP-1')).toMatchObject({
      generated: 4,
      kept: 2,
      edited: 1,
      deleted: 1,
      added: 1,
      approved: 4,
    });
    expect(report.totals).toMatchObject({
      generated: 6,
      kept: 4,
      edited: 1,
      deleted: 1,
      added: 1,
      approved: 4,
    });
    expect(report.totals.keptShare).toBeCloseTo(5 / 6);
    expect(report.totals.unchangedShare).toBeCloseTo(4 / 6);
    expect(report.totals.handWrittenShare).toBeCloseTo(1 / 6);
  });

  it('does not count a case QA added and then deleted as one of the AI cases', () => {
    const input = sampleRun();
    input.run.cases.push(makeCase('SHP-2', 'deleted', { origin: 'added' }));

    const report = buildReport([input]);

    expect(report.totals).toMatchObject({ generated: 6, deleted: 1, added: 1 });
  });

  it('measures the hand-written share against the final set, not against what the AI wrote', () => {
    const input = sampleRun();
    input.run.cases.push(makeCase('SHP-2', 'added'));

    const report = buildReport([input]);

    // 6 AI cases, 5 of them survived, 2 added: 2 of the 7 final cases were written by hand.
    expect(report.totals).toMatchObject({ generated: 6, added: 2 });
    expect(report.totals.handWrittenShare).toBeCloseTo(2 / 7);
  });

  it('leaves out cases a regeneration replaced, and counts the ones it made', () => {
    const input = sampleRun();
    const old = makeCase('SHP-2', 'deleted');
    input.run.cases.push(old);
    input.activity.replaced = [old.uid];

    const report = buildReport([input]);

    expect(report.totals).toMatchObject({ generated: 6, deleted: 1 });
    expect(report.replacedCases).toBe(1);
    expect(renderReport(report)).toContain(
      '1 case the tool wrote was replaced when a ticket was written again.',
    );
  });

  it('counts a replaced case that was restored, because it is live again', () => {
    const input = sampleRun();
    const restored = makeCase('SHP-2', 'generated');
    input.run.cases.push(restored);
    input.activity.replaced = [restored.uid];

    expect(buildReport([input]).totals.generated).toBe(7);
  });

  it('has no shares when the AI wrote nothing', () => {
    const report = buildReport([
      {
        run: makeRun('r', '2026-10-14T09:00:00Z', { tickets: [makeTicket('SHP-1')] }),
        activity: noActivity,
      },
    ]);

    expect(report.totals.keptShare).toBeNull();
    expect(report.recommendation).toBe('not-measured');
  });

  it('counts a ticket once, from its latest run', () => {
    const first = sampleRun();
    const second: PilotRunInput = {
      run: makeRun('run-2', '2026-10-15T09:00:00Z', {
        tickets: [makeTicket('SHP-1'), makeTicket('SHP-2')],
        cases: [makeCase('SHP-1', 'generated'), makeCase('SHP-2', 'edited')],
      }),
      activity: noActivity,
    };

    const report = buildReport([second, first]);

    expect(report.supersededRuns).toBe(1);
    expect(report.runs.map((r) => r.id)).toEqual(['run-2']);
    expect(report.totals).toMatchObject({ generated: 2, kept: 1, edited: 1, added: 0 });
  });

  it('keeps an older run for the tickets a later run did not repeat', () => {
    const first = sampleRun();
    const second: PilotRunInput = {
      run: makeRun('run-2', '2026-10-15T09:00:00Z', {
        tickets: [makeTicket('SHP-1')],
        cases: [makeCase('SHP-1', 'generated')],
      }),
      activity: noActivity,
    };

    const report = buildReport([first, second]);

    expect(report.supersededRuns).toBe(0);
    expect(report.tickets.map((t) => `${t.ticket}:${t.generated}`)).toEqual(['SHP-1:1', 'SHP-2:2']);
  });

  it('lists failed tickets and leaves them out of the case counts', () => {
    const input = sampleRun();
    input.run.tickets.push(makeTicket('SHP-3', { status: 'failed', error: 'boom' }));

    const report = buildReport([input]);

    expect(report.failedTickets).toEqual(['SHP-3']);
    expect(report.totals.generated).toBe(6);
  });
});

describe('buildReport time', () => {
  const baseline = (csv: string) => parseBaseline(csv).entries;

  it('compares manual time with review time plus the tool time of the same tickets', () => {
    // The run took 6 min over 2 tickets: 3 min each.
    const report = buildReport(
      [sampleRun()],
      baseline('ticket,manual_minutes,review_minutes\nSHP-1,60,20\nSHP-2,30,10\n'),
    );

    expect(report.time).toEqual({
      comparedTickets: 2,
      manualMinutes: 90,
      reviewMinutes: 30,
      aiMinutes: 6,
      savedMinutes: 54,
      savedShare: 54 / 90,
    });
  });

  it('only compares tickets that have both times', () => {
    const report = buildReport(
      [sampleRun()],
      baseline('ticket,manual_minutes,review_minutes\nSHP-1,60,20\nSHP-2,30,\n'),
    );

    expect(report.time).toMatchObject({
      comparedTickets: 1,
      manualMinutes: 60,
      reviewMinutes: 20,
      aiMinutes: 3,
      savedMinutes: 37,
    });
  });

  it('has no comparison without a baseline', () => {
    const report = buildReport([sampleRun()]);

    expect(report.time).toBeNull();
    expect(report.recommendation).toBe('not-measured');
  });

  it('shows a negative saving when the tool was slower', () => {
    const report = buildReport(
      [sampleRun()],
      baseline('ticket,manual_minutes,review_minutes\nSHP-1,5,20\n'),
    );

    expect(report.time?.savedMinutes).toBe(-18);
    expect(report.recommendation).toBe('not-yet');
  });

  it('spreads the run time over the tickets that finished, not the failed ones', () => {
    const input = sampleRun();
    input.run.tickets.push(makeTicket('SHP-3', { status: 'failed' }));

    const report = buildReport(
      [input],
      baseline('ticket,manual_minutes,review_minutes\nSHP-1,60,20\n'),
    );

    expect(report.time?.aiMinutes).toBe(3);
  });
});

describe('buildReport cost, review and gaps', () => {
  it('adds up tokens, calls, cost and time over the runs used', () => {
    const report = buildReport([sampleRun()]);

    expect(report.ai).toEqual({
      calls: 4,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.5,
      minutes: 6,
    });
  });

  it('reports no cost when no run was priced', () => {
    const input = sampleRun();
    input.run.estimatedCostUsd = null;

    expect(buildReport([input]).ai.costUsd).toBeNull();
  });

  it('takes the review window, people and edited fields from the activity', () => {
    const report = buildReport([sampleRun()]);

    expect(report.review.firstChangeAt).toEqual(new Date('2026-10-14T10:00:00Z'));
    expect(report.review.lastChangeAt).toEqual(new Date('2026-10-14T10:45:00Z'));
    expect(report.review.people).toEqual(['asha', 'qa']);
    expect(report.review.editedFields).toEqual([
      { field: 'title', edits: 2 },
      { field: 'expected', edits: 1 },
    ]);
  });

  it('lists what QA added, what no case covers and what the tickets lacked', () => {
    const report = buildReport([sampleRun()]);

    expect(report.missed.addedByQa).toEqual([
      { ticket: 'SHP-1', title: 'Tax is added for orders to Canada' },
    ]);
    expect(report.missed.uncoveredBehaviours).toEqual([
      { ticket: 'SHP-1', behaviour: 'Refund after partial ship' },
    ]);
    expect(report.missed.ticketGaps).toEqual([
      { missing: 'Which couriers apply', tickets: ['SHP-2'] },
    ]);
  });

  it('adds up the missed cases QA counted, and is null when QA counted none', () => {
    const counted = buildReport(
      [sampleRun()],
      parseBaseline('ticket,manual_minutes,missed_cases\nSHP-1,60,2\nSHP-2,30,1\n').entries,
    );
    expect(counted.missed.qaCounted).toBe(3);
    expect(buildReport([sampleRun()]).missed.qaCounted).toBeNull();
  });
});

describe('recommend', () => {
  it.each([
    [0.8, 0.5, 'adopt'],
    [THRESHOLDS.adoptKeptShare, THRESHOLDS.adoptTimeSaved, 'adopt'],
    [0.59, 0.5, 'adopt-with-changes'],
    [0.8, 0.29, 'adopt-with-changes'],
    [0.39, 0.5, 'not-yet'],
    [0.8, 0.09, 'not-yet'],
    [0.8, null, 'not-measured'],
    [null, 0.5, 'not-measured'],
  ] as const)('kept %s and saved %s is %s', (kept, saved, expected) => {
    expect(recommend(kept, saved)).toBe(expected);
  });
});

describe('renderReport', () => {
  const baseline = parseBaseline(
    'ticket,manual_minutes,review_minutes,missed_cases\nSHP-1,60,20,2\nSHP-2,30,10,\n',
  ).entries;

  it('states the measured numbers', () => {
    const text = renderReport(
      buildReport([sampleRun()], baseline, {
        title: 'Sprint 42 pilot',
        now: new Date('2026-10-20T00:00:00Z'),
      }),
    );

    expect(text).toContain('# Sprint 42 pilot');
    expect(text).toContain('Generated 2026-10-20 from 1 run and 2 tickets.');
    expect(text).toContain('| Time saved | 54 min of 90 (60%) on 2 tickets |');
    expect(text).toContain('| AI cases that survived review | 83% (4 unchanged, 1 edited, of 6) |');
    expect(text).toContain('| Cases QA had to add | 1 (17% of the final set) |');
    expect(text).toContain('| AI cost | $0.50 (4 calls, 1,000 in / 500 out tokens, 6 min) |');
    expect(text).toContain('**Adopt. The draft saves time and most of it survives review.**');
    expect(text).toContain('| SHP-1 | 4 | 2 | 1 | 1 | 1 | 60 | 20 |');
    expect(text).toContain('- SHP-1: Tax is added for orders to Canada');
    expect(text).toContain('title (2), expected (1)');
    expect(text).toContain('People recorded: asha, qa.');
    expect(text).toContain("QA's own count of missed cases: 2.");
  });

  it('says plainly when time was not measured', () => {
    const text = renderReport(buildReport([sampleRun()]));

    expect(text).toContain('not measured: no ticket has both a manual and a review time');
    expect(text).toContain('**Not measured.');
  });

  it('keeps table cells intact when a title holds a pipe', () => {
    const input = sampleRun();
    input.run.inputValue = 'a | b';
    const text = renderReport(buildReport([input]));

    expect(text).toContain('a \\| b');
  });

  it('leaves blanks for what only people can write', () => {
    const text = renderReport(buildReport([sampleRun()]));

    expect(text).toContain('## To write by hand');
    expect(text).toContain('- **Decision and owner:**');
  });

  it('is short enough for one page of a pilot: no raw case text beyond added titles', () => {
    const text = renderReport(buildReport([sampleRun()], baseline));

    expect(text.split('\n').length).toBeLessThan(70);
  });
});
