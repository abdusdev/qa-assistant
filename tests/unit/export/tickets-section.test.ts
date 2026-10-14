import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  CSV_COLUMNS,
  fromPipelineResult,
  fromStoredRun,
  toCsv,
  toDocx,
  toMarkdown,
  type ExportCase,
  type ExportRun,
} from '../../../src/export/index.js';
import type { TicketSnapshot } from '../../../src/jira/snapshot.js';
import { parseCsv } from '../../../src/knowledge/past-cases.js';
import { runPipeline } from '../../../src/pipeline/run.js';
import { makeTicket, scriptedAI } from '../pipeline/support.js';

const snapshot = (key: string, overrides: Partial<TicketSnapshot> = {}): TicketSnapshot => ({
  key,
  url: `https://example.atlassian.net/browse/${key}`,
  summary: `Summary of ${key}`,
  type: 'Story',
  status: 'Done',
  description: `Line one of ${key}.\n\nLine three of ${key}.`,
  labels: ['rates'],
  commentCount: 0,
  comments: [],
  truncated: false,
  ...overrides,
});

const exportCase = (ticket: string, id: string): ExportCase => ({
  id,
  ticket,
  flowStep: 'Happy path',
  title: `Case ${id} for ${ticket}`,
  type: 'ui',
  priority: 'medium',
  preconditions: [],
  steps: ['Do the thing'],
  expected: 'It works',
  sources: [],
  assumptions: [],
  dependsOn: [],
  covers: [],
  grounding: 'grounded',
  state: 'generated',
});

const runOf = (tickets: ExportRun['tickets'], keys: string[]): ExportRun => ({
  title: 'Test cases',
  source: `list ${keys.join(' ')}`,
  tickets,
  steps: [
    {
      order: 1,
      name: 'Happy path',
      description: '',
      caseIds: keys.map((_, i) => `TC-${i + 1}`),
    },
  ],
  cases: keys.map((key, i) => exportCase(key, `TC-${i + 1}`)),
  warnings: [],
  plan: [],
});

describe('the tickets section of a Markdown export', () => {
  it('comes before the summary and before every case', () => {
    const md = toMarkdown(
      runOf(
        [
          { key: 'SHP-1', snapshot: snapshot('SHP-1') },
          { key: 'SHP-2', snapshot: snapshot('SHP-2') },
        ],
        ['SHP-1', 'SHP-2'],
      ),
    );

    const tickets = md.indexOf('## Tickets covered');
    expect(tickets).toBeGreaterThan(-1);
    expect(tickets).toBeLessThan(md.indexOf('## Summary'));
    expect(tickets).toBeLessThan(md.indexOf('### TC-1'));
    expect(md.indexOf('### SHP-1: Summary of SHP-1')).toBeLessThan(md.indexOf('### SHP-2:'));
    expect(md).toContain('written against these tickets');
  });

  it('shows the full description with its line breaks, as a quotation', () => {
    const md = toMarkdown(runOf([{ key: 'SHP-1', snapshot: snapshot('SHP-1') }], ['SHP-1']));

    expect(md).toContain('> Line one of SHP-1.\n>\n> Line three of SHP-1.');
    expect(md).toContain('written against this ticket,');
  });

  it('shows type, status, labels and the link', () => {
    const md = toMarkdown(runOf([{ key: 'SHP-1', snapshot: snapshot('SHP-1') }], ['SHP-1']));

    expect(md).toContain(
      'Type: Story | Status: Done | Labels: rates | https://example.atlassian.net/browse/SHP-1',
    );
  });

  it('shows the acceptance criteria and the comments when the ticket has them', () => {
    const md = toMarkdown(
      runOf(
        [
          {
            key: 'SHP-1',
            snapshot: snapshot('SHP-1', {
              acceptanceCriteria: 'Rates from every carrier appear.',
              commentCount: 3,
              comments: [{ author: 'Asha', created: '2026-10-01T10:00:00Z', body: 'Seen on prod' }],
            }),
          },
        ],
        ['SHP-1'],
      ),
    );

    expect(md).toContain('**Acceptance criteria**');
    expect(md).toContain('> Rates from every carrier appear.');
    expect(md).toContain('**Comments (3)**');
    expect(md).toContain('> Asha, 2026-10-01: Seen on prod');
  });

  it('says when a ticket was cut short', () => {
    const md = toMarkdown(
      runOf([{ key: 'SHP-1', snapshot: snapshot('SHP-1', { truncated: true }) }], ['SHP-1']),
    );

    expect(md).toContain('shortened because it was very long');
  });

  it('names a ticket whose text was not kept, instead of leaving it out', () => {
    const md = toMarkdown(runOf([{ key: 'SHP-9', snapshot: null }], ['SHP-9']));

    expect(md).toContain('### SHP-9');
    expect(md).toContain('The ticket text was not saved with this run.');
  });

  it('has no tickets section when there are no tickets', () => {
    expect(toMarkdown(runOf([], ['SHP-1']))).not.toContain('Tickets covered');
  });
});

describe('the tickets section of a Word export', () => {
  const textOf = async (run: ExportRun) => {
    const zip = await JSZip.loadAsync(await toDocx(run));
    const xml = await zip.file('word/document.xml')!.async('string');
    return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  };

  it('puts every ticket and its text before the summary and the cases', async () => {
    const text = await textOf(
      runOf(
        [
          { key: 'SHP-1', snapshot: snapshot('SHP-1') },
          { key: 'SHP-2', snapshot: snapshot('SHP-2') },
        ],
        ['SHP-1', 'SHP-2'],
      ),
    );

    const tickets = text.indexOf('Tickets covered');
    expect(tickets).toBeGreaterThan(-1);
    expect(tickets).toBeLessThan(text.indexOf('At a glance'));
    expect(tickets).toBeLessThan(text.indexOf('Case TC-1 for SHP-1'));
    expect(text).toContain('SHP-1: Summary of SHP-1');
    expect(text).toContain('Line one of SHP-1.');
    expect(text).toContain('Line three of SHP-2.');
    expect(text.indexOf('SHP-1: Summary')).toBeLessThan(text.indexOf('SHP-2: Summary'));
  });

  it('names a ticket whose text was not kept', async () => {
    const text = await textOf(runOf([{ key: 'SHP-9', snapshot: null }], ['SHP-9']));

    expect(text).toContain('The ticket text was not saved with this run.');
  });

  it('has no tickets section when there are no tickets', async () => {
    expect(await textOf(runOf([], ['SHP-1']))).not.toContain('Tickets covered');
  });
});

describe('the ticket summary column of a CSV export', () => {
  it('repeats the ticket summary on each of its cases', () => {
    const rows = parseCsv(
      toCsv(
        runOf(
          [
            { key: 'SHP-1', snapshot: snapshot('SHP-1') },
            { key: 'SHP-2', snapshot: null },
          ],
          ['SHP-1', 'SHP-2'],
        ),
      ),
    );
    const column = CSV_COLUMNS.indexOf('Ticket summary');

    expect(rows[1]![column]).toBe('Summary of SHP-1');
    expect(rows[2]![column]).toBe('');
  });
});

describe('where the ticket text comes from', () => {
  it('takes it from the saved run', () => {
    const stored = {
      id: 'r1',
      createdAt: new Date('2026-10-12T10:00:00Z'),
      inputMode: 'list',
      inputValue: 'SHP-1 SHP-2',
      model: 'm',
      warnings: [],
      tickets: [
        { ticket: 'SHP-1', plan: null, snapshot: snapshot('SHP-1') },
        { ticket: 'SHP-2', plan: null, snapshot: null },
      ],
      flow: [],
      cases: [],
    };

    const run = fromStoredRun(stored as never, { title: 'T' });

    expect(run.tickets).toEqual([
      { key: 'SHP-1', snapshot: snapshot('SHP-1') },
      { key: 'SHP-2', snapshot: null },
    ]);
  });

  it('takes it from a result file that carries it, and leaves the rest empty', async () => {
    const result = await runPipeline(scriptedAI({}), [makeTicket('SHP-1'), makeTicket('SHP-2')]);

    const run = fromPipelineResult(result, { title: 'T', snapshots: [snapshot('SHP-2')] });

    expect(run.tickets).toEqual([
      { key: 'SHP-1', snapshot: null },
      { key: 'SHP-2', snapshot: snapshot('SHP-2') },
    ]);
  });
});
