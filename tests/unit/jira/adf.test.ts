import { describe, expect, it } from 'vitest';
import { adfToText } from '../../../src/jira/adf.js';

const text = (value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({
  type: 'text',
  text: value,
  ...(marks && { marks }),
});
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const listItem = (...content: unknown[]) => ({ type: 'listItem', content });

describe('adfToText', () => {
  describe('empty and plain input', () => {
    it('returns an empty string for null, undefined and non-document values', () => {
      expect(adfToText(null)).toBe('');
      expect(adfToText(undefined)).toBe('');
      expect(adfToText(42)).toBe('');
    });

    it('returns plain strings trimmed', () => {
      expect(adfToText('  already plain text \n')).toBe('already plain text');
    });

    it('returns an empty string for an empty document', () => {
      expect(adfToText(doc())).toBe('');
    });
  });

  describe('text blocks', () => {
    it('separates paragraphs with a blank line', () => {
      const result = adfToText(doc(paragraph(text('First.')), paragraph(text('Second.'))));
      expect(result).toBe('First.\n\nSecond.');
    });

    it('joins styled text runs inside one paragraph', () => {
      const result = adfToText(
        doc(paragraph(text('Click '), text('Save', [{ type: 'strong' }]), text(' to continue'))),
      );
      expect(result).toBe('Click Save to continue');
    });

    it('renders headings with their level', () => {
      const result = adfToText(
        doc(
          { type: 'heading', attrs: { level: 2 }, content: [text('Acceptance criteria')] },
          paragraph(text('Body')),
        ),
      );
      expect(result).toBe('## Acceptance criteria\n\nBody');
    });

    it('renders a hard break as a new line', () => {
      const result = adfToText(
        doc(paragraph(text('line one'), { type: 'hardBreak' }, text('line two'))),
      );
      expect(result).toBe('line one\nline two');
    });

    it('renders a horizontal rule', () => {
      expect(adfToText(doc(paragraph(text('a')), { type: 'rule' }, paragraph(text('b'))))).toBe(
        'a\n\n---\n\nb',
      );
    });
  });

  describe('links', () => {
    it('shows the address after the link text', () => {
      const link = text('API docs', [
        { type: 'link', attrs: { href: 'https://example.com/docs' } },
      ]);
      expect(adfToText(doc(paragraph(link)))).toBe('API docs (https://example.com/docs)');
    });

    it('does not repeat the address when the link text is the address', () => {
      const url = 'https://example.com/docs';
      const link = text(url, [{ type: 'link', attrs: { href: url } }]);
      expect(adfToText(doc(paragraph(link)))).toBe(url);
    });
  });

  describe('lists', () => {
    it('renders bullet lists', () => {
      const result = adfToText(
        doc({
          type: 'bulletList',
          content: [listItem(paragraph(text('one'))), listItem(paragraph(text('two')))],
        }),
      );
      expect(result).toBe('- one\n- two');
    });

    it('renders ordered lists, honouring the start number', () => {
      const result = adfToText(
        doc({
          type: 'orderedList',
          attrs: { order: 3 },
          content: [listItem(paragraph(text('third'))), listItem(paragraph(text('fourth')))],
        }),
      );
      expect(result).toBe('3. third\n4. fourth');
    });

    it('indents nested lists under their parent item', () => {
      const result = adfToText(
        doc({
          type: 'bulletList',
          content: [
            listItem(paragraph(text('parent')), {
              type: 'bulletList',
              content: [listItem(paragraph(text('child')))],
            }),
            listItem(paragraph(text('sibling'))),
          ],
        }),
      );
      expect(result).toBe('- parent\n  - child\n- sibling');
    });

    it('renders task lists with their done state', () => {
      const result = adfToText(
        doc({
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('written')] },
            { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('reviewed')] },
          ],
        }),
      );
      expect(result).toBe('- [x] written\n- [ ] reviewed');
    });
  });

  describe('structured blocks', () => {
    it('renders code blocks with their language', () => {
      const result = adfToText(
        doc({
          type: 'codeBlock',
          attrs: { language: 'json' },
          content: [text('{ "ok": true }')],
        }),
      );
      expect(result).toBe('```json\n{ "ok": true }\n```');
    });

    it('prefixes every line of a quote', () => {
      const result = adfToText(
        doc({
          type: 'blockquote',
          content: [paragraph(text('quoted one')), paragraph(text('quoted two'))],
        }),
      );
      expect(result).toBe('> quoted one\n> \n> quoted two');
    });

    it('renders tables with a header separator', () => {
      const cell = (type: string, value: string) => ({ type, content: [paragraph(text(value))] });
      const result = adfToText(
        doc({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [cell('tableHeader', 'Courier'), cell('tableHeader', 'Limit')],
            },
            { type: 'tableRow', content: [cell('tableCell', 'FedEx'), cell('tableCell', '50')] },
          ],
        }),
      );
      expect(result).toBe('| Courier | Limit |\n| --- | --- |\n| FedEx | 50 |');
    });

    it('labels panels by type', () => {
      const result = adfToText(
        doc({
          type: 'panel',
          attrs: { panelType: 'warning' },
          content: [paragraph(text('Careful'))],
        }),
      );
      expect(result).toBe('Warning: Careful');
    });

    it('keeps the title and content of expand sections', () => {
      const result = adfToText(
        doc({
          type: 'expand',
          attrs: { title: 'Details' },
          content: [paragraph(text('Hidden text'))],
        }),
      );
      expect(result).toBe('Details:\nHidden text');
    });
  });

  describe('inline items', () => {
    it('renders mentions, emoji, status, dates and smart links', () => {
      const result = adfToText(
        doc(
          paragraph(
            { type: 'mention', attrs: { id: '1', text: '@Safiuddin' } },
            text(' '),
            { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } },
            text(' '),
            { type: 'status', attrs: { text: 'READY FOR QA', color: 'blue' } },
            text(' due '),
            { type: 'date', attrs: { timestamp: '1760054400000' } },
            text(' see '),
            { type: 'inlineCard', attrs: { url: 'https://example.com/pr/1' } },
          ),
        ),
      );
      expect(result).toBe(
        '@Safiuddin 😄 [READY FOR QA] due 2025-10-10 see https://example.com/pr/1',
      );
    });

    it('uses a placeholder for attachments and images', () => {
      const result = adfToText(
        doc(
          { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'abc', type: 'file' } }] },
          paragraph(text('see'), { type: 'mediaInline', attrs: { id: 'x' } }),
        ),
      );
      expect(result).toBe('[attachment]\n\nsee[attachment]');
    });
  });

  describe('missing attributes', () => {
    it('falls back sensibly for inline items without attributes', () => {
      const result = adfToText(
        doc(
          paragraph(
            { type: 'mention' },
            text('|'),
            { type: 'emoji', attrs: { shortName: ':smile:' } },
            text('|'),
            { type: 'emoji' },
            text('|'),
            { type: 'status' },
            text('|'),
            { type: 'date', attrs: { timestamp: 'abc' } },
            text('|'),
            { type: 'inlineCard' },
            text('|'),
            text('no address', [{ type: 'link', attrs: {} }]),
          ),
        ),
      );
      expect(result).toBe('@user|:smile:||[]|||no address');
    });

    it('keeps headings within levels 1 to 6', () => {
      const heading = (attrs?: Record<string, unknown>) => ({
        type: 'heading',
        ...(attrs && { attrs }),
        content: [text('Title')],
      });
      expect(adfToText(doc(heading()))).toBe('# Title');
      expect(adfToText(doc(heading({ level: 9 })))).toBe('###### Title');
    });

    it('renders code blocks, panels and expands without optional attributes', () => {
      expect(adfToText(doc({ type: 'codeBlock', content: [text('x = 1')] }))).toBe(
        '```\nx = 1\n```',
      );
      expect(adfToText(doc({ type: 'panel', content: [paragraph(text('Plain panel'))] }))).toBe(
        'Plain panel',
      );
      expect(adfToText(doc({ type: 'expand', content: [paragraph(text('Body'))] }))).toBe('Body');
    });

    it('does not add a header separator to tables without a header row', () => {
      const cell = (value: string) => ({ type: 'tableCell', content: [paragraph(text(value))] });
      const result = adfToText(
        doc({ type: 'table', content: [{ type: 'tableRow', content: [cell('a'), cell('b')] }] }),
      );
      expect(result).toBe('| a | b |');
    });

    it('handles a top-level node that is not wrapped in a document', () => {
      expect(adfToText(paragraph(text('bare paragraph')))).toBe('bare paragraph');
    });

    it('keeps block children of unknown containers apart', () => {
      const result = adfToText(
        doc({
          type: 'layoutSection',
          content: [paragraph(text('left')), paragraph(text('right'))],
        }),
      );
      expect(result).toBe('left\n\nright');
    });
  });

  describe('resilience', () => {
    it('keeps the text of unknown nodes instead of dropping or throwing', () => {
      const result = adfToText(
        doc(
          { type: 'someFutureNode', content: [text('still readable')] },
          paragraph(text('after')),
        ),
      );
      expect(result).toBe('still readable\n\nafter');
    });

    it('ignores malformed nodes without content', () => {
      expect(
        adfToText(doc({ type: 'bulletList' }, { type: 'paragraph' }, paragraph(text('ok')))),
      ).toBe('ok');
    });

    it('converts a realistic ticket description', () => {
      const result = adfToText(
        doc(
          { type: 'heading', attrs: { level: 3 }, content: [text('Bulk shipment creation')] },
          paragraph(text('As a seller I can create shipments for selected orders.')),
          {
            type: 'orderedList',
            content: [
              listItem(paragraph(text('Select orders'))),
              listItem(paragraph(text('Click '), text('Create shipments', [{ type: 'strong' }]))),
            ],
          },
          paragraph(text('Max 100 orders per request.')),
        ),
      );
      expect(result).toBe(
        [
          '### Bulk shipment creation',
          '',
          'As a seller I can create shipments for selected orders.',
          '',
          '1. Select orders',
          '2. Click Create shipments',
          '',
          'Max 100 orders per request.',
        ].join('\n'),
      );
    });
  });
});
