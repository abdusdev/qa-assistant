import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../../src/knowledge/past-cases.js';
import {
  AI_DRAFT_NOTICE,
  CSV_COLUMNS,
  csvField,
  fromPipelineResult,
  fromStoredRun,
  groupByFlow,
  summarize,
  toCsv,
  toDocx,
  toMarkdown,
  type ExportCase,
  type ExportRun,
} from '../../../src/export/index.js';
import { runPipeline } from '../../../src/pipeline/run.js';
import { makeTicket, scriptedAI } from '../pipeline/support.js';

const exportCase = (overrides: Partial<ExportCase> = {}): ExportCase => ({
  id: 'TC-1',
  ticket: 'SHP-1',
  flowStep: 'Happy path',
  title: 'Rates are cleared when the destination changes',
  type: 'ui',
  priority: 'high',
  preconditions: ['An order with fetched rates'],
  steps: ['Open the order', 'Change the destination', 'Save'],
  expected: 'The old rates are marked outdated',
  sources: [{ from: 'ticket', quote: 'rates must be fetched again' }],
  assumptions: [],
  dependsOn: [],
  covers: ['B1'],
  grounding: 'grounded',
  state: 'generated',
  ...overrides,
});

const sampleRun = (): ExportRun => ({
  title: 'Test cases for SHP-1',
  source: 'ticket SHP-1',
  generatedAt: new Date('2026-10-12T10:00:00Z'),
  model: 'gemini-test',
  author: 'Tech',
  steps: [
    { order: 2, name: 'Failures', description: 'What goes wrong', caseIds: ['TC-3', 'TC-2'] },
    { order: 1, name: 'Happy path', description: 'The normal journey', caseIds: ['TC-1'] },
  ],
  cases: [
    exportCase(),
    exportCase({
      id: 'TC-2',
      title: 'Shipping is blocked, "stale" rates | pipe',
      flowStep: 'Failures',
      priority: 'medium',
      state: 'edited',
      assumptions: ['The button is called "Ship"'],
      grounding: 'partly',
      dependsOn: ['TC-1'],
      covers: ['B2'],
    }),
    exportCase({ id: 'TC-3', title: 'A case QA removed', state: 'deleted', flowStep: 'Failures' }),
    exportCase({ id: 'TC-4', title: 'A case QA added by hand', state: 'added', flowStep: 'Other' }),
  ],
  warnings: ['SHP-1 has too little detail for reliable cases.'],
  plan: [
    { ticket: 'SHP-1', id: 'B1', behaviour: 'Rates are cleared', coveredBy: ['TC-1'] },
    { ticket: 'SHP-1', id: 'B2', behaviour: 'Name edits keep the rates | really', coveredBy: [] },
  ],
});

describe('groupByFlow', () => {
  it('follows the flow order and leaves deleted cases out', () => {
    const groups = groupByFlow(sampleRun());

    expect(groups.map((g) => [g.step.name, g.cases.map((c) => c.id)])).toEqual([
      ['Happy path', ['TC-1']],
      ['Failures', ['TC-2']],
      ['Other', ['TC-4']],
    ]);
  });

  it('puts a case that no step lists into a final group, so nothing disappears', () => {
    const run = { ...sampleRun(), steps: [] };

    const groups = groupByFlow(run);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.step.name).toBe('Other');
    expect(groups[0]?.cases.map((c) => c.id)).toEqual(['TC-1', 'TC-2', 'TC-4']);
  });

  it('shows a case once even when two steps list it', () => {
    const run = sampleRun();
    run.steps = [
      { order: 1, name: 'First', description: '', caseIds: ['TC-1'] },
      { order: 2, name: 'Second', description: '', caseIds: ['TC-1', 'TC-2'] },
    ];

    const ids = groupByFlow(run).flatMap((g) => g.cases.map((c) => c.id));

    expect(ids.filter((id) => id === 'TC-1')).toHaveLength(1);
  });
});

describe('summarize', () => {
  it('counts what QA kept, edited, deleted and added', () => {
    const summary = summarize(sampleRun().cases);

    expect(summary).toEqual({
      generated: 3,
      kept: 1,
      edited: 1,
      deleted: 1,
      added: 1,
      total: 3,
      keptShare: 2 / 3,
    });
  });

  it('is all zeros for no cases', () => {
    expect(summarize([])).toEqual({
      generated: 0,
      kept: 0,
      edited: 0,
      deleted: 0,
      added: 0,
      total: 0,
      keptShare: 0,
    });
  });
});

describe('toMarkdown', () => {
  const markdown = toMarkdown(sampleRun());

  it('starts with the title and the AI draft notice', () => {
    expect(markdown.startsWith('# Test cases for SHP-1\n')).toBe(true);
    expect(markdown).toContain(`> **${AI_DRAFT_NOTICE}**`);
  });

  it('states where it came from, the model and the author', () => {
    expect(markdown).toContain('Source: ticket SHP-1');
    expect(markdown).toContain('Generated: 2026-10-12');
    expect(markdown).toContain('Model: gemini-test');
    expect(markdown).toContain('Author: Tech');
  });

  it('summarises what QA did', () => {
    expect(markdown).toContain('- Cases: 3');
    expect(markdown).toContain('kept: 1, edited: 1, deleted: 1; added by QA: 1');
  });

  it('groups the cases by flow step, in order, without deleted ones', () => {
    const order = ['## 1. Happy path', '## 2. Failures', '## 3. Other'].map((h) =>
      markdown.indexOf(h),
    );

    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markdown).toContain('### TC-1: Rates are cleared');
    expect(markdown).not.toContain('A case QA removed');
  });

  it('shows each case with steps, expected result, review status and what it is based on', () => {
    expect(markdown).toContain('1. Open the order');
    expect(markdown).toContain('**Expected result:** The old rates are marked outdated');
    expect(markdown).toContain('AI draft: needs QA review');
    expect(markdown).toContain('Edited by QA');
    expect(markdown).toContain('Added by QA');
    expect(markdown).toContain('- Ticket description: "rates must be fetched again"');
    expect(markdown).toContain('**Runs after:** TC-1');
    expect(markdown).toContain('- The button is called "Ship"');
  });

  it('lists the behaviours and marks the ones with no case', () => {
    expect(markdown).toContain('| SHP-1 | Rates are cleared | TC-1 |');
    expect(markdown).toContain(
      '| SHP-1 | Name edits keep the rates \\| really | **not covered** |',
    );
  });

  it('ends with the notes and a single new line', () => {
    expect(markdown).toContain('## Notes');
    expect(markdown).toContain('- SHP-1 has too little detail for reliable cases.');
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown.endsWith('\n\n')).toBe(false);
  });

  it('leaves out the sections that have nothing in them', () => {
    const bare = toMarkdown({ ...sampleRun(), plan: [], warnings: [] });

    expect(bare).not.toContain('What the cases cover');
    expect(bare).not.toContain('## Notes');
  });
});

describe('toCsv', () => {
  const csv = toCsv(sampleRun());
  const rows = parseCsv(csv);

  it('starts with a byte order mark so Excel reads the text correctly', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('has the header and one row per case that was not deleted, in flow order', () => {
    expect(rows[0]).toEqual([...CSV_COLUMNS]);
    expect(rows.slice(1).map((r) => r[1])).toEqual(['TC-1', 'TC-2', 'TC-4']);
    expect(rows.slice(1).map((r) => r[3])).toEqual(['Happy path', 'Failures', 'Other']);
  });

  it('puts the AI draft notice on every row it applies to', () => {
    const status = rows.slice(1).map((r) => r[0]);

    expect(status).toEqual(['AI draft: needs QA review', 'Edited by QA', 'Added by QA']);
  });

  it('keeps commas, quotes and line breaks inside their cell', () => {
    const second = rows[2] as string[];

    expect(second[4]).toBe('Shipping is blocked, "stale" rates | pipe');
    expect(second[8]).toBe('1. Open the order\n2. Change the destination\n3. Save');
    expect(second[11]).toBe('The button is called "Ship"');
  });

  it('uses Windows line endings between rows', () => {
    expect(csv.split('\r\n').length).toBe(rows.length + 1);
  });

  it('writes a field that needs quoting with the quotes doubled', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
  });

  it('stops a spreadsheet from running case text as a formula', () => {
    const run = sampleRun();
    run.cases = [exportCase({ title: '=HYPERLINK("http://example.com","click")', id: 'TC-9' })];
    run.steps = [{ order: 1, name: 'Happy path', description: '', caseIds: ['TC-9'] }];

    const title = (parseCsv(toCsv(run))[1] as string[])[4] as string;

    expect(title.startsWith("'=")).toBe(true);
  });
});

describe('toDocx', () => {
  it('is a Word file with the notice, the author and the cases in it', async () => {
    const buffer = await toDocx(sampleRun());
    const zip = await JSZip.loadAsync(buffer);
    const document = await zip.file('word/document.xml')!.async('string');
    const text = document.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const core = await zip.file('docProps/core.xml')!.async('string');

    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(text).toContain(AI_DRAFT_NOTICE);
    expect(text).toContain('Author: Tech');
    expect(text).toContain('Test cases for SHP-1');
    expect(text).toContain('TC-1');
    expect(text).toContain('Rates are cleared when the destination changes');
    expect(text).toContain('NOT COVERED');
    expect(text).toContain('Edited by QA');
    expect(text).not.toContain('A case QA removed');
    expect(core).toContain('<dc:creator>Tech</dc:creator>');
  });

  it('uses a default author when none is given', async () => {
    const run = { ...sampleRun() };
    delete run.author;

    const zip = await JSZip.loadAsync(await toDocx(run));
    const core = await zip.file('docProps/core.xml')!.async('string');

    expect(core).toContain('QA Assistant');
  });
});

describe('adapters', () => {
  it('turns a pipeline result into an export with its plan and coverage', async () => {
    const ai = scriptedAI({
      planFor: () => [
        { id: 'B1', behaviour: 'First behaviour' },
        { id: 'B2', behaviour: 'Second behaviour' },
      ],
      casesFor: () => [
        { title: 'Alpha one unique scenario', expected: 'Beta one holds', covers: ['B1'] },
      ],
    });
    const result = await runPipeline(ai, [makeTicket('SHP-1')]);

    const run = fromPipelineResult(result, { title: 'From a file', author: 'Tech' });

    expect(run.cases).toHaveLength(1);
    expect(run.cases[0]).toMatchObject({ state: 'generated', covers: ['B1'] });
    expect(run.plan).toEqual([
      { ticket: 'SHP-1', id: 'B1', behaviour: 'First behaviour', coveredBy: ['TC-1'] },
      { ticket: 'SHP-1', id: 'B2', behaviour: 'Second behaviour', coveredBy: [] },
    ]);
    expect(run.model).toBe('scripted');
    expect(run.author).toBe('Tech');
    expect(toMarkdown(run)).toContain('Alpha one unique scenario');
  });

  it('turns a saved run into an export with what QA did', () => {
    const stored = {
      id: 'r1',
      createdAt: new Date('2026-10-12T10:00:00Z'),
      inputMode: 'ticket',
      inputValue: 'SHP-1',
      model: 'gemini-test',
      warnings: ['a warning'],
      tickets: [
        {
          ticket: 'SHP-1',
          plan: { items: [{ id: 'B1', behaviour: 'First' }], uncovered: [] },
        },
      ],
      flow: [{ position: 0, name: 'Happy path', description: '', caseCodes: ['TC-1', 'TC-2'] }],
      cases: [
        {
          ...exportCase(),
          flow_step: 'Happy path',
          depends_on: [],
          covers: ['B1'],
          state: 'edited',
        },
        {
          ...exportCase({ id: 'TC-2' }),
          flow_step: 'Happy path',
          depends_on: [],
          state: 'deleted',
        },
      ],
    };

    const run = fromStoredRun(stored as never, { title: 'From the database' });

    expect(run.source).toBe('ticket SHP-1');
    expect(run.steps).toEqual([
      { order: 1, name: 'Happy path', description: '', caseIds: ['TC-1', 'TC-2'] },
    ]);
    expect(run.plan).toEqual([
      { ticket: 'SHP-1', id: 'B1', behaviour: 'First', coveredBy: ['TC-1'] },
    ]);
    expect(summarize(run.cases)).toMatchObject({ edited: 1, deleted: 1, total: 1 });
  });
});
