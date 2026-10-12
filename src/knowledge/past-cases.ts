import { CASE_TYPES, PRIORITIES } from '../ai/schemas.js';

/** A test case QA approved before, used as a style example and a regression hint. */
export interface PastCase {
  title: string;
  module: string | undefined;
  type: string | undefined;
  priority: string | undefined;
  steps: string[];
  expected: string;
  /** The file it came from, for traceability. */
  source: string;
}

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * Reads past cases from Markdown. Each case is a "## Title" section:
 *
 *   ## Create shipments for all selected orders
 *   - Module: Shipments
 *   - Type: ui
 *   - Priority: high
 *
 *   Steps:
 *   1. Select three orders
 *   2. Click Create shipments
 *
 *   Expected: One shipment is created per selected order
 */
export function parsePastCases(
  markdown: string,
  source: string,
  defaultModule?: string,
): PastCase[] {
  const sections = markdown.replace(/\r\n/g, '\n').split(/^## +/m).slice(1);
  const cases: PastCase[] = [];

  for (const section of sections) {
    const [titleLine = '', ...rest] = section.split('\n');
    const title = clean(titleLine);
    if (title === '') continue;

    let module: string | undefined = defaultModule;
    let type: string | undefined;
    let priority: string | undefined;
    const steps: string[] = [];
    const expected: string[] = [];
    let mode: 'meta' | 'steps' | 'expected' = 'meta';

    for (const raw of rest) {
      const line = raw.trim();
      if (line === '') continue;

      const meta = /^[-*]\s*(module|type|priority)\s*:\s*(.+)$/i.exec(line);
      if (meta?.[1] && meta[2]) {
        const value = clean(meta[2]);
        const key = meta[1].toLowerCase();
        if (key === 'module') module = value;
        else if (key === 'type') type = value.toLowerCase();
        else priority = value.toLowerCase();
        continue;
      }

      if (/^steps\s*:?\s*$/i.test(line)) {
        mode = 'steps';
        continue;
      }
      const expectedLine = /^expected(?: result)?\s*:\s*(.*)$/i.exec(line);
      if (expectedLine) {
        mode = 'expected';
        if (expectedLine[1]) expected.push(clean(expectedLine[1]));
        continue;
      }

      if (mode === 'steps') steps.push(clean(line.replace(/^(\d+[.)]|[-*])\s*/, '')));
      else if (mode === 'expected') expected.push(clean(line));
    }

    cases.push({
      title,
      module,
      type,
      priority,
      steps: steps.filter((step) => step !== ''),
      expected: expected.join(' '),
      source,
    });
  }
  return cases;
}

/** Writes past cases in the format parsePastCases reads. */
export function serializePastCases(cases: PastCase[]): string {
  return (
    cases
      .map((c) =>
        [
          `## ${c.title}`,
          ...(c.module ? [`- Module: ${c.module}`] : []),
          ...(c.type ? [`- Type: ${c.type}`] : []),
          ...(c.priority ? [`- Priority: ${c.priority}`] : []),
          '',
          'Steps:',
          ...c.steps.map((step, index) => `${index + 1}. ${step}`),
          '',
          `Expected: ${c.expected}`,
        ].join('\n'),
      )
      .join('\n\n') + '\n'
  );
}

/** One case as it is shown to the model. */
export function formatPastCase(c: PastCase): string {
  const header = [c.type, c.priority].filter(Boolean).join(', ');
  return [
    `Case: ${c.title}${header ? ` (${header})` : ''}`,
    ...(c.steps.length > 0 ? [`Steps: ${c.steps.map((s, i) => `${i + 1}) ${s}`).join(' ')}`] : []),
    `Expected: ${c.expected}`,
  ].join('\n');
}

// ---- CSV import ------------------------------------------------------------------------------

/** Reads CSV (quoted fields, commas and new lines inside quotes, "" for a quote). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // A byte order mark (U+FEFF) at the start, written by some spreadsheet exports, is not data.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const char = input[i] as string;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const HEADER_NAMES: Record<string, string[]> = {
  title: ['title', 'summary', 'name', 'test case', 'test case name', 'scenario'],
  steps: ['steps', 'test steps', 'step', 'procedure'],
  expected: ['expected', 'expected result', 'expected results', 'expected outcome'],
  module: ['module', 'component', 'feature', 'area', 'folder'],
  type: ['type', 'test type', 'layer'],
  priority: ['priority', 'severity'],
};

const PRIORITY_ALIASES: Record<string, string> = {
  critical: 'high',
  highest: 'high',
  blocker: 'high',
  major: 'high',
  normal: 'medium',
  minor: 'low',
  lowest: 'low',
  trivial: 'low',
};

const TYPE_ALIASES: Record<string, string> = {
  ui: 'ui',
  e2e: 'ui',
  functional: 'ui',
  manual: 'ui',
  api: 'api',
  integration: 'api',
  unit: 'unit',
};

function normalizePriority(value: string): string | undefined {
  const key = value.trim().toLowerCase();
  if ((PRIORITIES as readonly string[]).includes(key)) return key;
  return PRIORITY_ALIASES[key];
}

function normalizeType(value: string): string | undefined {
  const key = value.trim().toLowerCase();
  if ((CASE_TYPES as readonly string[]).includes(key)) return key;
  return TYPE_ALIASES[key];
}

export interface CsvImportResult {
  cases: PastCase[];
  /** Rows that were left out, with the reason. */
  skipped: { row: number; reason: string }[];
  /** Which CSV column was used for each field. */
  columns: Record<string, string>;
}

/**
 * Turns a CSV export (a sheet, Zephyr, Xray...) into past cases. Column names are matched
 * loosely ("Test Steps", "Expected Result", "Component"...). Steps may be on separate lines,
 * separated by "|" or ";", or numbered.
 */
export function importCsv(csv: string, source: string, defaultModule?: string): CsvImportResult {
  const rows = parseCsv(csv);
  const header = rows[0];
  if (!header) return { cases: [], skipped: [], columns: {} };

  const columnOf = (field: string): number =>
    header.findIndex((cell) => (HEADER_NAMES[field] ?? []).includes(cell.trim().toLowerCase()));

  const index = Object.fromEntries(
    Object.keys(HEADER_NAMES).map((field) => [field, columnOf(field)]),
  );
  const columns = Object.fromEntries(
    Object.entries(index)
      .filter(([, position]) => position >= 0)
      .map(([field, position]) => [field, (header[position] as string).trim()]),
  );

  const cases: PastCase[] = [];
  const skipped: CsvImportResult['skipped'] = [];

  if ((index.title ?? -1) < 0) {
    return { cases, skipped: [{ row: 1, reason: 'No title column was found.' }], columns };
  }

  rows.slice(1).forEach((cells, offset) => {
    const row = offset + 2;
    const cell = (field: string) => {
      const position = index[field] ?? -1;
      return position >= 0 ? (cells[position] ?? '').trim() : '';
    };

    const title = clean(cell('title'));
    if (title === '') {
      skipped.push({ row, reason: 'The title is empty.' });
      return;
    }
    const expected = clean(cell('expected'));
    if (expected === '') {
      skipped.push({ row, reason: 'The expected result is empty.' });
      return;
    }

    const steps = cell('steps')
      .split(/\r?\n|\||;/)
      .map((step) => clean(step.replace(/^(\d+[.)]|[-*])\s*/, '')))
      .filter((step) => step !== '');

    cases.push({
      title,
      module: cell('module') !== '' ? clean(cell('module')) : defaultModule,
      type: normalizeType(cell('type')),
      priority: normalizePriority(cell('priority')),
      steps,
      expected,
      source,
    });
  });

  return { cases, skipped, columns };
}
