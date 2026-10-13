import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  AI_DRAFT_NOTICE,
  GROUNDING_LABEL,
  REVIEW_STATUS,
  SOURCE_LABEL,
  groupByFlow,
  summarize,
  type ExportCase,
  type ExportRun,
} from './model.js';

const INK = '1F2933';
const MUTED = '616E7C';
const BRAND = '0B5CAD';
const HEADER_FILL = 'E6EEF7';
const LINE = 'C9D3DD';
const WARN = 'B42318';
const FONT = 'Calibri';

const cap = (value: string) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value);

const run = (
  value: string,
  options: { bold?: boolean; color?: string; italics?: boolean; size?: number } = {},
) =>
  new TextRun({
    text: value,
    font: FONT,
    size: options.size ?? 21,
    color: options.color ?? INK,
    ...options,
  });

const paragraph = (children: TextRun[] | string, after = 100) =>
  new Paragraph({
    spacing: { after, line: 276 },
    children: typeof children === 'string' ? [run(children)] : children,
  });

const heading = (value: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]) =>
  new Paragraph({
    heading: level,
    spacing: { before: level === HeadingLevel.HEADING_1 ? 320 : 220, after: 120 },
    children: [
      run(value, {
        bold: true,
        color: level === HeadingLevel.HEADING_1 ? BRAND : INK,
        size: level === HeadingLevel.HEADING_1 ? 30 : 24,
      }),
    ],
  });

const bullet = (value: string) =>
  new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 60, line: 276 },
    children: [run(value)],
  });

const numbered = (value: string, n: number) =>
  new Paragraph({
    spacing: { after: 60, line: 276 },
    indent: { left: 360, hanging: 360 },
    children: [run(`${n}.  `, { color: MUTED }), run(value)],
  });

const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
const borders = { top: border, bottom: border, left: border, right: border };

const cell = (
  children: Paragraph[],
  width: number,
  extra: { span?: number; shaded?: boolean } = {},
) =>
  new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    borders,
    ...(extra.span && { columnSpan: extra.span }),
    ...(extra.shaded && { shading: { type: ShadingType.CLEAR, fill: HEADER_FILL, color: 'auto' } }),
    children,
  });

const headerCell = (value: string, width: number) =>
  cell([paragraph([run(value, { bold: true })], 0)], width, { shaded: true });

const textCell = (value: string, width: number, options: { bold?: boolean; color?: string } = {}) =>
  cell([paragraph([run(value, options)], 0)], width);

const table = (widths: number[], rows: TableRow[]) =>
  new Table({
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    rows,
  });

function caseTable(c: ExportCase): Table {
  const rows: TableRow[] = [
    new TableRow({
      cantSplit: true,
      children: [
        cell([paragraph([run(`${c.id}  ${c.title}`, { bold: true, size: 22 })], 0)], 9360, {
          span: 2,
          shaded: true,
        }),
      ],
    }),
  ];
  const add = (label: string, body: Paragraph[]) =>
    rows.push(new TableRow({ children: [headerCell(label, 1900), cell(body, 7460)] }));

  add('Type / priority', [
    paragraph(
      `${c.type.toUpperCase()}  |  ${cap(c.priority)} priority  |  ${c.ticket}  |  ${REVIEW_STATUS[c.state]}`,
      0,
    ),
  ]);
  if (c.covers.length > 0) add('Covers', [paragraph(c.covers.join(', '), 0)]);
  if (c.preconditions.length > 0) add('Preconditions', c.preconditions.map(bullet));
  add(
    'Steps',
    c.steps.map((step, i) => numbered(step, i + 1)),
  );
  add('Expected result', [paragraph(c.expected, 0)]);
  if (c.dependsOn.length > 0) add('Runs after', [paragraph(c.dependsOn.join(', '), 0)]);

  const sources = c.sources.filter((s) => s.from !== 'inferred' || s.quote !== '');
  add('Based on', [
    paragraph([run(GROUNDING_LABEL[c.grounding], { bold: true })], 60),
    ...sources.map((s) =>
      paragraph(
        [
          run(SOURCE_LABEL[s.from], { color: MUTED }),
          ...(s.quote ? [run(`: "${s.quote}"`, { italics: true })] : []),
        ],
        40,
      ),
    ),
  ]);
  if (c.assumptions.length > 0) add('To confirm', c.assumptions.map(bullet));

  return table([1900, 7460], rows);
}

/** The run as a Word document: notice, summary, coverage, flow, then every case in flow order. */
export async function toDocx(source: ExportRun): Promise<Buffer> {
  const groups = groupByFlow(source);
  const summary = summarize(source.cases);
  const author = source.author ?? 'QA Assistant';
  const children: (Paragraph | Table)[] = [];

  children.push(
    new Paragraph({
      spacing: { after: 60 },
      children: [
        run('TEST CASES  |  AI DRAFT FOR QA REVIEW', { bold: true, color: MUTED, size: 18 }),
      ],
    }),
    new Paragraph({
      spacing: { after: 80 },
      children: [run(source.title, { bold: true, size: 40 })],
    }),
    paragraph(
      [
        run(
          [
            `Source: ${source.source}`,
            source.generatedAt && `Generated: ${source.generatedAt.toISOString().slice(0, 10)}`,
            source.model && `Model: ${source.model}`,
            `Author: ${author}`,
          ]
            .filter(Boolean)
            .join('  |  '),
          { color: MUTED },
        ),
      ],
      160,
    ),
    paragraph([run(AI_DRAFT_NOTICE, { bold: true, color: WARN })], 200),
  );

  // At a glance
  children.push(heading('At a glance', HeadingLevel.HEADING_1));
  const glance: [string, string][] = [
    ['Test cases', String(summary.total)],
    ['Flow steps', String(groups.length)],
  ];
  if (summary.generated > 0 || summary.added > 0) {
    glance.push([
      'What QA did',
      `${summary.kept} kept, ${summary.edited} edited, ${summary.deleted} deleted, ${summary.added} added`,
    ]);
  }
  children.push(
    table(
      [2400, 6960],
      glance.map(
        ([label, value]) =>
          new TableRow({ children: [headerCell(label, 2400), textCell(value, 6960)] }),
      ),
    ),
  );

  // Coverage
  if (source.plan.length > 0) {
    children.push(heading('What the cases cover', HeadingLevel.HEADING_1));
    children.push(
      paragraph(
        'Before writing cases, the system lists the behaviours it found. Each should have at least one case.',
      ),
    );
    children.push(
      table(
        [1100, 5260, 3000],
        [
          new TableRow({
            tableHeader: true,
            children: [
              headerCell('Ticket', 1100),
              headerCell('Behaviour', 5260),
              headerCell('Covered by', 3000),
            ],
          }),
          ...source.plan.map(
            (item) =>
              new TableRow({
                children: [
                  textCell(item.ticket, 1100),
                  textCell(`${item.id}  ${item.behaviour}`, 5260),
                  item.coveredBy.length > 0
                    ? textCell(item.coveredBy.join(', '), 3000)
                    : textCell('NOT COVERED', 3000, { bold: true, color: WARN }),
                ],
              }),
          ),
        ],
      ),
    );
  }

  // Flow overview
  children.push(heading('Test flow', HeadingLevel.HEADING_1));
  children.push(
    paragraph('Run the steps in this order. Cases inside a step run in the order listed.'),
  );
  for (const { step, cases } of groups) {
    children.push(heading(`${step.order}. ${step.name}`, HeadingLevel.HEADING_2));
    if (step.description) children.push(paragraph(step.description));
    children.push(
      table(
        [900, 5360, 900, 1100, 1100],
        [
          new TableRow({
            tableHeader: true,
            children: [
              headerCell('ID', 900),
              headerCell('Case', 5360),
              headerCell('Type', 900),
              headerCell('Priority', 1100),
              headerCell('Backing', 1100),
            ],
          }),
          ...cases.map(
            (c) =>
              new TableRow({
                children: [
                  textCell(c.id, 900, { bold: true }),
                  textCell(c.title, 5360),
                  textCell(c.type.toUpperCase(), 900),
                  textCell(cap(c.priority), 1100),
                  textCell(cap(c.grounding), 1100),
                ],
              }),
          ),
        ],
      ),
    );
  }

  // Cases
  children.push(heading('Test cases', HeadingLevel.HEADING_1));
  for (const { cases } of groups) {
    for (const c of cases) {
      children.push(caseTable(c), paragraph('', 140));
    }
  }

  if (source.warnings.length > 0) {
    children.push(heading('Notes', HeadingLevel.HEADING_1));
    for (const warning of source.warnings) children.push(bullet(warning));
  }

  const doc = new Document({
    creator: author,
    lastModifiedBy: author,
    title: source.title,
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1080, bottom: 1080, left: 1273, right: 1273 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  run(`${source.title}, AI draft for review  |  Page `, { color: MUTED, size: 16 }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: FONT,
                    size: 16,
                    color: MUTED,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
