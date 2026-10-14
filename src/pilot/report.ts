/**
 * The pilot report: what the tool produced for a set of runs, what QA did with it, and, when QA
 * has recorded their manual times, how much time it saved.
 *
 * Everything here is a pure function of stored runs, so the numbers can be tested exactly. The
 * report states what is measured and what QA entered; it never invents a number.
 */
import type { ReviewActivity, StoredRun } from '../db/repository.js';
import type { BaselineEntry } from './baseline.js';

export interface PilotRunInput {
  run: StoredRun;
  activity: ReviewActivity;
}

export interface CaseCounts {
  /** Cases the AI wrote. */
  generated: number;
  /** AI cases left exactly as written. */
  kept: number;
  /** AI cases QA changed. */
  edited: number;
  /** AI cases QA removed. */
  deleted: number;
  /** Cases QA wrote by hand. */
  added: number;
  /** Cases (not deleted) that a person approved. */
  approved: number;
}

export interface TicketRow extends CaseCounts {
  ticket: string;
  status: 'ok' | 'failed' | 'skipped';
  /** Minutes QA entered, when a baseline was supplied for this ticket. */
  manualMinutes: number | null;
  reviewMinutes: number | null;
  missedCases: number | null;
}

export type Recommendation = 'adopt' | 'adopt-with-changes' | 'not-yet' | 'not-measured';

/** The rule behind the suggested reading. Shown in the report so it can be argued with. */
export const THRESHOLDS = {
  /** Share of AI cases that survived review (kept or edited) for "adopt". */
  adoptKeptShare: 0.6,
  /** Share of QA's manual time saved for "adopt". */
  adoptTimeSaved: 0.3,
  /** Below either of these the answer is "not yet". */
  minKeptShare: 0.4,
  minTimeSaved: 0.1,
} as const;

export interface PilotReport {
  title: string;
  generatedAt: Date;
  runs: {
    id: string;
    createdAt: Date;
    inputValue: string;
    model: string | null;
    promptVersion: string;
  }[];
  /** Tickets in earlier runs that a later run of the same ticket replaced in this report. */
  supersededRuns: number;
  /** Cases the tool wrote that a regeneration replaced. Not counted anywhere below. */
  replacedCases: number;
  tickets: TicketRow[];
  failedTickets: string[];
  totals: CaseCounts & {
    /** (kept + edited) / generated, from 0 to 1. Null when the AI wrote nothing. */
    keptShare: number | null;
    /** kept / generated. */
    unchangedShare: number | null;
    /** added / (kept + edited + added): the share of the final set that QA had to write. */
    handWrittenShare: number | null;
  };
  ai: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    /** Null when no run recorded a price. */
    costUsd: number | null;
    /** Minutes the pipeline took, summed over runs. */
    minutes: number;
  };
  review: {
    firstChangeAt: Date | null;
    lastChangeAt: Date | null;
    people: string[];
    editedFields: { field: string; edits: number }[];
  };
  time: {
    /** Tickets with both a manual and a review time, the ones the comparison uses. */
    comparedTickets: number;
    manualMinutes: number;
    reviewMinutes: number;
    aiMinutes: number;
    savedMinutes: number;
    /** savedMinutes / manualMinutes. */
    savedShare: number;
  } | null;
  missed: {
    addedByQa: { ticket: string; title: string }[];
    uncoveredBehaviours: { ticket: string; behaviour: string }[];
    ticketGaps: { missing: string; tickets: string[] }[];
    qaCounted: number | null;
  };
  recommendation: Recommendation;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);

function emptyCounts(): CaseCounts {
  return { generated: 0, kept: 0, edited: 0, deleted: 0, added: 0, approved: 0 };
}

export function recommend(keptShare: number | null, savedShare: number | null): Recommendation {
  if (savedShare === null || keptShare === null) return 'not-measured';
  if (savedShare < THRESHOLDS.minTimeSaved || keptShare < THRESHOLDS.minKeptShare) return 'not-yet';
  if (savedShare >= THRESHOLDS.adoptTimeSaved && keptShare >= THRESHOLDS.adoptKeptShare) {
    return 'adopt';
  }
  return 'adopt-with-changes';
}

export function buildReport(
  inputs: PilotRunInput[],
  baseline: BaselineEntry[] = [],
  options: { title?: string; now?: Date } = {},
): PilotReport {
  // A ticket that was run again counts once, from its latest run: the pilot measures the draft
  // QA actually reviewed, not every attempt.
  const ordered = [...inputs].sort((a, b) => a.run.createdAt.getTime() - b.run.createdAt.getTime());
  const latestRunOf = new Map<string, string>();
  for (const { run } of ordered) {
    for (const ticket of run.tickets) latestRunOf.set(ticket.ticket, run.id);
  }
  const usedRuns = new Set(latestRunOf.values());
  const supersededRuns = ordered.filter(({ run }) => !usedRuns.has(run.id)).length;
  const used = ordered.filter(({ run }) => usedRuns.has(run.id));

  const baselineOf = new Map(baseline.map((entry) => [entry.ticket, entry]));
  const tickets: TicketRow[] = [];
  const addedByQa: PilotReport['missed']['addedByQa'] = [];
  const uncovered: PilotReport['missed']['uncoveredBehaviours'] = [];
  const gaps = new Map<string, Set<string>>();
  const failedTickets: string[] = [];
  let replacedCases = 0;
  const ticketRunMinutes = new Map<string, number>();

  for (const { run, activity } of used) {
    const replaced = new Set(activity.replaced);
    const okTickets = run.tickets.filter((t) => t.status === 'ok').length;
    const runMinutes = (run.durationMs ?? 0) / 60_000;
    for (const ticket of run.tickets) {
      if (latestRunOf.get(ticket.ticket) !== run.id) continue;
      const counts = emptyCounts();
      for (const testCase of run.cases) {
        if (testCase.ticket !== ticket.ticket) continue;
        // A regeneration took this case out; the new cases are what QA reviewed.
        if (replaced.has(testCase.uid) && testCase.state === 'deleted') {
          replacedCases += 1;
          continue;
        }
        // Origin, not state, says who wrote a case: a case QA added and then deleted is not one
        // of the AI's.
        if (testCase.origin === 'generated') {
          counts.generated += 1;
          if (testCase.state === 'deleted') counts.deleted += 1;
          else if (testCase.state === 'edited') counts.edited += 1;
          else counts.kept += 1;
        } else if (testCase.state !== 'deleted') {
          counts.added += 1;
          addedByQa.push({ ticket: ticket.ticket, title: testCase.title });
        }
        if (testCase.approved && testCase.state !== 'deleted') counts.approved += 1;
      }
      for (const behaviour of ticket.plan?.uncovered ?? []) {
        uncovered.push({ ticket: ticket.ticket, behaviour });
      }
      for (const missing of ticket.detail?.missing ?? []) {
        const key = missing.trim();
        if (key === '') continue;
        gaps.set(key, (gaps.get(key) ?? new Set()).add(ticket.ticket));
      }
      if (ticket.status !== 'ok') failedTickets.push(ticket.ticket);

      const entry = baselineOf.get(ticket.ticket);
      tickets.push({
        ticket: ticket.ticket,
        status: ticket.status,
        ...counts,
        manualMinutes: entry?.manualMinutes ?? null,
        reviewMinutes: entry?.reviewMinutes ?? null,
        missedCases: entry?.missedCases ?? null,
      });
      // The pipeline's time is per run. Each ticket that finished carries an equal part of it.
      ticketRunMinutes.set(ticket.ticket, ticket.status === 'ok' ? runMinutes / okTickets : 0);
    }
  }

  // Readable and stable: by project, then ticket number, whatever order the runs came in.
  tickets.sort((a, b) => a.ticket.localeCompare(b.ticket, 'en', { numeric: true }));

  const totals = tickets.reduce<CaseCounts>((sum, row) => {
    for (const key of Object.keys(sum) as (keyof CaseCounts)[]) sum[key] += row[key];
    return sum;
  }, emptyCounts());

  const priced = used.filter(({ run }) => run.estimatedCostUsd !== null);
  const editedFields = new Map<string, number>();
  const people = new Set<string>();
  let first: Date | null = null;
  let last: Date | null = null;
  for (const { activity } of used) {
    for (const person of activity.people) people.add(person);
    for (const [field, count] of Object.entries(activity.editedFields)) {
      editedFields.set(field, (editedFields.get(field) ?? 0) + count);
    }
    if (activity.firstChangeAt && (!first || activity.firstChangeAt < first)) {
      first = activity.firstChangeAt;
    }
    if (activity.lastChangeAt && (!last || activity.lastChangeAt > last)) {
      last = activity.lastChangeAt;
    }
  }

  const compared = tickets.filter(
    (row) => row.status === 'ok' && row.manualMinutes !== null && row.reviewMinutes !== null,
  );
  let time: PilotReport['time'] = null;
  if (compared.length > 0) {
    const manualMinutes = compared.reduce((sum, row) => sum + (row.manualMinutes ?? 0), 0);
    const reviewMinutes = compared.reduce((sum, row) => sum + (row.reviewMinutes ?? 0), 0);
    const aiMinutes = compared.reduce(
      (sum, row) => sum + (ticketRunMinutes.get(row.ticket) ?? 0),
      0,
    );
    const savedMinutes = manualMinutes - reviewMinutes - aiMinutes;
    time = {
      comparedTickets: compared.length,
      manualMinutes: round1(manualMinutes),
      reviewMinutes: round1(reviewMinutes),
      aiMinutes: round1(aiMinutes),
      savedMinutes: round1(savedMinutes),
      savedShare: manualMinutes === 0 ? 0 : savedMinutes / manualMinutes,
    };
  }

  const keptShare = share(totals.kept + totals.edited, totals.generated);
  const counted = tickets.filter((row) => row.missedCases !== null);

  return {
    title: options.title ?? 'Pilot report',
    generatedAt: options.now ?? new Date(),
    runs: used.map(({ run }) => ({
      id: run.id,
      createdAt: run.createdAt,
      inputValue: run.inputValue,
      model: run.model,
      promptVersion: run.promptVersion,
    })),
    supersededRuns,
    replacedCases,
    tickets,
    failedTickets,
    totals: {
      ...totals,
      keptShare,
      unchangedShare: share(totals.kept, totals.generated),
      handWrittenShare: share(totals.added, totals.kept + totals.edited + totals.added),
    },
    ai: {
      calls: used.reduce((sum, { run }) => sum + run.calls, 0),
      inputTokens: used.reduce((sum, { run }) => sum + run.inputTokens, 0),
      outputTokens: used.reduce((sum, { run }) => sum + run.outputTokens, 0),
      costUsd:
        priced.length === 0
          ? null
          : priced.reduce((sum, { run }) => sum + (run.estimatedCostUsd ?? 0), 0),
      minutes: round1(used.reduce((sum, { run }) => sum + (run.durationMs ?? 0), 0) / 60_000),
    },
    review: {
      firstChangeAt: first,
      lastChangeAt: last,
      people: [...people].sort(),
      editedFields: [...editedFields]
        .map(([field, edits]) => ({ field, edits }))
        .sort((a, b) => b.edits - a.edits || a.field.localeCompare(b.field)),
    },
    time,
    missed: {
      addedByQa,
      uncoveredBehaviours: uncovered,
      ticketGaps: [...gaps]
        .map(([missing, set]) => ({ missing, tickets: [...set].sort() }))
        .sort((a, b) => b.tickets.length - a.tickets.length || a.missing.localeCompare(b.missing)),
      qaCounted:
        counted.length === 0 ? null : counted.reduce((s, r) => s + (r.missedCases ?? 0), 0),
    },
    recommendation: recommend(keptShare, time ? time.savedShare : null),
  };
}

// ---- Markdown ----------------------------------------------------------------------------------

const percent = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value * 100)}%`);
const day = (date: Date) => date.toISOString().slice(0, 10);
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function span(from: Date | null, to: Date | null): string {
  if (!from || !to) return 'no changes recorded';
  const minutes = Math.round((to.getTime() - from.getTime()) / 60_000);
  const text = minutes < 90 ? `${minutes} min` : `${round1(minutes / 60)} h`;
  return `${from.toISOString().slice(0, 16).replace('T', ' ')} to ${to
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ')} UTC (${text} between the first and last change)`;
}

const READING: Record<Recommendation, string> = {
  adopt: 'Adopt. The draft saves time and most of it survives review.',
  'adopt-with-changes':
    'Adopt with changes. It helps, but not enough of the draft survives or not enough time is saved yet. Fix the gaps below first.',
  'not-yet': 'Not yet. Too little of the draft survives review or too little time is saved.',
  'not-measured':
    'Not measured. Record manual and review times (see the baseline file) to get a time comparison.',
};

export function renderReport(report: PilotReport): string {
  const { totals, ai, time, missed, review } = report;
  const lines: string[] = [];
  const out = (line = '') => lines.push(line);

  out(`# ${report.title}`);
  out();
  out(
    `Generated ${day(report.generatedAt)} from ${report.runs.length} run${report.runs.length === 1 ? '' : 's'}` +
      ` and ${report.tickets.length} ticket${report.tickets.length === 1 ? '' : 's'}.` +
      ' The test cases are an AI draft that QA reviewed; this report only counts what happened.',
  );
  if (report.supersededRuns > 0) {
    out(
      `${report.supersededRuns} earlier run${report.supersededRuns === 1 ? ' was' : 's were'} left out because a later run covers the same tickets.`,
    );
  }
  if (report.replacedCases > 0) {
    out(
      `${report.replacedCases} case${report.replacedCases === 1 ? '' : 's'} the tool wrote ${report.replacedCases === 1 ? 'was' : 'were'} replaced when a ticket was written again. They are not counted here, so these numbers can differ from the review page, which lists them as deleted.`,
    );
  }
  out();

  out('## Result');
  out();
  out(`**${READING[report.recommendation]}**`);
  out();
  out('| Measure | Value |');
  out('| --- | --- |');
  if (time) {
    out(
      `| Time saved | ${time.savedMinutes} min of ${time.manualMinutes} (${percent(time.savedShare)}) on ${time.comparedTickets} ticket${time.comparedTickets === 1 ? '' : 's'} |`,
    );
    out(
      `| Manual time / tool time | ${time.manualMinutes} min / ${round1(time.reviewMinutes + time.aiMinutes)} min (review ${time.reviewMinutes} + tool ${time.aiMinutes}) |`,
    );
  } else {
    out('| Time saved | not measured: no ticket has both a manual and a review time |');
  }
  out(
    `| AI cases that survived review | ${percent(totals.keptShare)} (${totals.kept} unchanged, ${totals.edited} edited, of ${totals.generated}) |`,
  );
  out(`| AI cases deleted | ${totals.deleted} |`);
  out(
    `| Cases QA had to add | ${totals.added} (${percent(totals.handWrittenShare)} of the final set) |`,
  );
  out(`| Cases approved | ${totals.approved} |`);
  out(
    `| AI cost | ${ai.costUsd === null ? 'not priced' : `$${ai.costUsd.toFixed(2)}`} (${ai.calls} calls, ${ai.inputTokens.toLocaleString('en-US')} in / ${ai.outputTokens.toLocaleString('en-US')} out tokens, ${ai.minutes} min) |`,
  );
  out();
  out(
    `Reading rule: adopt needs at least ${percent(THRESHOLDS.adoptKeptShare)} of cases surviving and ${percent(THRESHOLDS.adoptTimeSaved)} of time saved; below ${percent(THRESHOLDS.minKeptShare)} surviving or ${percent(THRESHOLDS.minTimeSaved)} saved is "not yet". It is a starting point for the team's decision, not the decision.`,
  );
  out();

  out('## By ticket');
  out();
  out('| Ticket | AI cases | Kept | Edited | Deleted | Added | Manual min | Review min |');
  out('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of report.tickets) {
    const note = row.status === 'ok' ? '' : ` (${row.status})`;
    out(
      `| ${row.ticket}${note} | ${row.generated} | ${row.kept} | ${row.edited} | ${row.deleted} | ${row.added} | ${row.manualMinutes ?? '-'} | ${row.reviewMinutes ?? '-'} |`,
    );
  }
  out();

  out('## What the tool missed');
  out();
  if (missed.addedByQa.length === 0) {
    out('QA added no cases of their own.');
  } else {
    out(
      `QA wrote ${missed.addedByQa.length} case${missed.addedByQa.length === 1 ? '' : 's'} the tool did not:`,
    );
    out();
    for (const item of missed.addedByQa.slice(0, 15)) {
      out(`- ${item.ticket}: ${cell(item.title)}`);
    }
    if (missed.addedByQa.length > 15) out(`- and ${missed.addedByQa.length - 15} more`);
  }
  if (missed.qaCounted !== null) {
    out();
    out(`QA's own count of missed cases: ${missed.qaCounted}.`);
  }
  if (missed.uncoveredBehaviours.length > 0) {
    out();
    out('Behaviours the tool planned but no case covers:');
    out();
    for (const item of missed.uncoveredBehaviours.slice(0, 10)) {
      out(`- ${item.ticket}: ${cell(item.behaviour)}`);
    }
  }
  if (missed.ticketGaps.length > 0) {
    out();
    out('Information the tickets did not give (missing knowledge to add):');
    out();
    for (const gap of missed.ticketGaps.slice(0, 10)) {
      out(`- ${cell(gap.missing)} (${gap.tickets.join(', ')})`);
    }
  }
  out();

  out('## What QA changed');
  out();
  if (review.editedFields.length === 0) {
    out('No edits were recorded on the cases.');
  } else {
    out(
      review.editedFields.map((item) => `${item.field} (${item.edits})`).join(', ') +
        '. The most edited field is the first place to look for a prompt change.',
    );
  }
  out();
  out(`Review window: ${span(review.firstChangeAt, review.lastChangeAt)}.`);
  out(
    `People recorded: ${review.people.length === 0 ? 'none' : review.people.join(', ')}. The window is elapsed time, not working time; use the review minutes QA recorded for the comparison.`,
  );
  out();

  if (report.failedTickets.length > 0) {
    out('## Tickets that did not produce cases');
    out();
    out(report.failedTickets.join(', '));
    out();
  }

  out('## To write by hand');
  out();
  out('- **What the tool did well:**');
  out('- **What it got wrong or missed that the numbers do not show:**');
  out('- **Prompt or knowledge changes to make first:**');
  out('- **Next feature, if any:**');
  out('- **Decision and owner:**');
  out();

  out('## Runs');
  out();
  for (const run of report.runs) {
    out(
      `- ${run.id} (${day(run.createdAt)}, ${cell(run.inputValue)}; ${run.model ?? 'no model'}, prompt ${run.promptVersion})`,
    );
  }
  out();
  return lines.join('\n');
}
