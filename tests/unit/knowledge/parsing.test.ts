import { describe, expect, it } from 'vitest';
import { asList, asText, parseFrontMatter } from '../../../src/knowledge/frontmatter.js';
import {
  formatPastCase,
  importCsv,
  parseCsv,
  parsePastCases,
  serializePastCases,
} from '../../../src/knowledge/past-cases.js';

describe('parseFrontMatter', () => {
  it('reads values and lists, and returns the body', () => {
    const { data, body } = parseFrontMatter(
      [
        '---',
        'name: Shipments',
        'components: [Shipments, "Shipping Rates"]',
        "labels: ['rates']",
        '---',
        '',
        'Body text here.',
      ].join('\n'),
    );

    expect(data).toEqual({
      name: 'Shipments',
      components: ['Shipments', 'Shipping Rates'],
      labels: ['rates'],
    });
    expect(body).toBe('Body text here.');
  });

  it('returns the whole text when there is no header', () => {
    expect(parseFrontMatter('Just text\nmore')).toEqual({ data: {}, body: 'Just text\nmore' });
  });

  it('returns the whole text when the header is never closed', () => {
    const text = '---\nname: x\nno end';
    expect(parseFrontMatter(text).data).toEqual({});
    expect(parseFrontMatter(text).body).toContain('no end');
  });

  it('handles Windows line endings and an empty list', () => {
    const { data } = parseFrontMatter('---\r\nname: A\r\nkeywords: []\r\n---\r\nbody');

    expect(data).toEqual({ name: 'A', keywords: [] });
  });

  it('ignores lines that are not key: value', () => {
    const { data } = parseFrontMatter('---\nname: A\njust some words\n---\nbody');

    expect(data).toEqual({ name: 'A' });
  });

  it('turns values into lists and text', () => {
    expect(asList(undefined)).toEqual([]);
    expect(asList('one')).toEqual(['one']);
    expect(asList('')).toEqual([]);
    expect(asList(['a', 'b'])).toEqual(['a', 'b']);
    expect(asText(undefined)).toBeUndefined();
    expect(asText('')).toBeUndefined();
    expect(asText(['a', 'b'])).toBe('a, b');
  });
});

describe('parsePastCases', () => {
  const markdown = [
    '## Create shipments for all selected orders',
    '- Module: Shipments',
    '- Type: UI',
    '- Priority: High',
    '',
    'Steps:',
    '1. Select three orders',
    '2) Click "Create shipments"',
    '- Wait for the dialog',
    '',
    'Expected: One shipment is created per selected order',
    'and the dialog lists all three',
    '',
    '## Second case',
    'Steps:',
    '1. Do the thing',
    'Expected result: It works as the ticket says',
  ].join('\n');

  it('reads title, details, steps and the expected result', () => {
    const [first] = parsePastCases(markdown, 'cases.md');

    expect(first).toEqual({
      title: 'Create shipments for all selected orders',
      module: 'Shipments',
      type: 'ui',
      priority: 'high',
      steps: ['Select three orders', 'Click "Create shipments"', 'Wait for the dialog'],
      expected: 'One shipment is created per selected order and the dialog lists all three',
      source: 'cases.md',
    });
  });

  it('reads every case, with "Expected result" accepted too', () => {
    const cases = parsePastCases(markdown, 'cases.md');

    expect(cases.map((c) => c.title)).toEqual([
      'Create shipments for all selected orders',
      'Second case',
    ]);
    expect(cases[1]?.expected).toBe('It works as the ticket says');
  });

  it('uses the default module when a case names none', () => {
    const [, second] = parsePastCases(markdown, 'cases.md', 'Orders');

    expect(second?.module).toBe('Orders');
  });

  it('returns nothing for text without cases', () => {
    expect(parsePastCases('Just some notes.', 'x.md')).toEqual([]);
  });

  it('survives a round trip through serializePastCases', () => {
    const cases = parsePastCases(markdown, 'cases.md');

    expect(parsePastCases(serializePastCases(cases), 'cases.md')).toEqual(cases);
  });

  it('shows a case to the model with its steps and expected result', () => {
    const [first] = parsePastCases(markdown, 'cases.md');

    expect(formatPastCase(first!)).toBe(
      [
        'Case: Create shipments for all selected orders (ui, high)',
        'Steps: 1) Select three orders 2) Click "Create shipments" 3) Wait for the dialog',
        'Expected: One shipment is created per selected order and the dialog lists all three',
      ].join('\n'),
    );
  });
});

describe('parseCsv', () => {
  it('reads plain rows', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('reads quoted fields with commas, quotes and new lines', () => {
    const rows = parseCsv('title,steps\n"Hello, world","line one\nline ""two"""\n');

    expect(rows[1]).toEqual(['Hello, world', 'line one\nline "two"']);
  });

  it('handles Windows line endings, a missing final newline and a byte order mark', () => {
    expect(parseCsv('﻿a,b\r\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('drops completely empty rows', () => {
    expect(parseCsv('a,b\n\n,\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('importCsv', () => {
  const csv = [
    'Test Case Name,Test Steps,Expected Result,Component,Priority,Test Type',
    '"Create shipments","1. Select orders\n2. Click Create",One shipment per order,Shipments,Critical,Functional',
    'Void a shipment,Open it | Click Void,It is voided,Shipments,Minor,API',
    ',Some steps,Some result,Shipments,High,UI',
    'No expected result,Some steps,,Shipments,High,UI',
  ].join('\n');

  it('matches columns by name and tidies the values', () => {
    const result = importCsv(csv, 'export.csv');

    expect(result.columns).toEqual({
      title: 'Test Case Name',
      steps: 'Test Steps',
      expected: 'Expected Result',
      module: 'Component',
      type: 'Test Type',
      priority: 'Priority',
    });
    expect(result.cases).toEqual([
      {
        title: 'Create shipments',
        module: 'Shipments',
        type: 'ui',
        priority: 'high',
        steps: ['Select orders', 'Click Create'],
        expected: 'One shipment per order',
        source: 'export.csv',
      },
      {
        title: 'Void a shipment',
        module: 'Shipments',
        type: 'api',
        priority: 'low',
        steps: ['Open it', 'Click Void'],
        expected: 'It is voided',
        source: 'export.csv',
      },
    ]);
  });

  it('lists the rows it left out and why', () => {
    const result = importCsv(csv, 'export.csv');

    expect(result.skipped).toEqual([
      { row: 4, reason: 'The title is empty.' },
      { row: 5, reason: 'The expected result is empty.' },
    ]);
  });

  it('uses the default module when there is no module column', () => {
    const result = importCsv('Title,Expected\nA case,A result\n', 'x.csv', 'Orders');

    expect(result.cases[0]).toMatchObject({ module: 'Orders', steps: [] });
  });

  it('reports a file without a title column', () => {
    const result = importCsv('Foo,Bar\n1,2\n', 'x.csv');

    expect(result.cases).toEqual([]);
    expect(result.skipped).toEqual([{ row: 1, reason: 'No title column was found.' }]);
  });

  it('leaves out type and priority it does not recognise', () => {
    const result = importCsv('Title,Expected,Priority,Type\nA,B,Whenever,Weird\n', 'x.csv');

    expect(result.cases[0]).toMatchObject({ priority: undefined, type: undefined });
  });

  it('handles an empty file', () => {
    expect(importCsv('', 'x.csv')).toEqual({ cases: [], skipped: [], columns: {} });
  });
});
