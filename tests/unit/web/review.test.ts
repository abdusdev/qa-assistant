import { describe, expect, it } from 'vitest';
import {
  draftOf,
  draftProblem,
  emptyDraft,
  exportUrl,
  keptShareText,
  linesOf,
  newCaseOf,
  patchOf,
  reviewText,
} from '../../../web/src/lib/review.js';
import type { ApiCase } from '../../../web/src/lib/types.js';

const apiCase = (overrides: Partial<ApiCase> = {}): ApiCase => ({
  uid: 'u1',
  id: 'TC-1',
  ticket: 'SHP-1',
  flow_step: 'Happy path',
  title: 'Rates are cleared when the destination changes',
  type: 'ui',
  priority: 'high',
  preconditions: ['An order with fetched rates'],
  steps: ['Open the order', 'Change the destination', 'Save'],
  expected: 'The old rates are marked outdated',
  sources: [],
  assumptions: ['The button is called Ship'],
  depends_on: [],
  grounding: 'grounded',
  ...overrides,
});

describe('linesOf', () => {
  it('gives one item per non-empty line, trimmed, with any line ending', () => {
    expect(linesOf('  one \r\n\ntwo\n  \nthree')).toEqual(['one', 'two', 'three']);
    expect(linesOf('')).toEqual([]);
  });
});

describe('draftOf and patchOf', () => {
  it('turns a case into text fields and back to no change', () => {
    const c = apiCase();

    expect(draftOf(c)).toEqual({
      title: 'Rates are cleared when the destination changes',
      type: 'ui',
      priority: 'high',
      flow_step: 'Happy path',
      preconditions: 'An order with fetched rates',
      steps: 'Open the order\nChange the destination\nSave',
      expected: 'The old rates are marked outdated',
      assumptions: 'The button is called Ship',
    });
    expect(patchOf(c, draftOf(c))).toEqual({});
  });

  it('names only the fields that were changed', () => {
    const c = apiCase();
    const draft = { ...draftOf(c), title: '  A clearer title for the case ', priority: 'low' };

    expect(patchOf(c, draft)).toEqual({ title: 'A clearer title for the case', priority: 'low' });
  });

  it('turns edited lists into lists, and an emptied list into an empty one', () => {
    const c = apiCase();
    const draft = {
      ...draftOf(c),
      steps: 'Open the order\n\nChange the destination and save',
      assumptions: '',
    };

    expect(patchOf(c, draft)).toEqual({
      steps: ['Open the order', 'Change the destination and save'],
      assumptions: [],
    });
  });

  it('ignores blank lines and spaces that change nothing', () => {
    const c = apiCase();
    const draft = { ...draftOf(c), steps: 'Open the order\r\nChange the destination\nSave\n\n' };

    expect(patchOf(c, draft)).toEqual({});
  });

  it('moves a case to another flow step', () => {
    const c = apiCase();

    expect(patchOf(c, { ...draftOf(c), flow_step: 'Regression' })).toEqual({
      flow_step: 'Regression',
    });
  });
});

describe('draftProblem', () => {
  const ok = {
    ...emptyDraft('Happy path'),
    title: 'A good title',
    steps: 'Do it',
    expected: 'It works',
  };

  it('accepts a complete draft', () => {
    expect(draftProblem(ok)).toBeUndefined();
  });

  it.each([
    ['a title that is too short', { title: 'abc' }, 'at least 5'],
    ['a title that is too long', { title: 'x'.repeat(201) }, 'at most 200'],
    ['no steps', { steps: ' \n ' }, 'at least one step'],
    ['no expected result', { expected: '  ' }, 'expected result'],
    ['no flow step', { flow_step: ' ' }, 'flow step'],
  ])('refuses %s', (_name, change, text) => {
    expect(draftProblem({ ...ok, ...change })).toContain(text);
  });
});

describe('newCaseOf', () => {
  it('builds the body the API expects', () => {
    const body = newCaseOf('SHP-2', {
      ...emptyDraft(),
      title: '  A case written by hand ',
      flow_step: ' Happy path ',
      type: 'api',
      priority: 'high',
      steps: 'Send the request\nRead the answer',
      expected: ' It answers ',
      preconditions: 'A key',
      assumptions: '',
    });

    expect(body).toEqual({
      ticket: 'SHP-2',
      flow_step: 'Happy path',
      title: 'A case written by hand',
      type: 'api',
      priority: 'high',
      steps: ['Send the request', 'Read the answer'],
      expected: 'It answers',
      preconditions: ['A key'],
      assumptions: [],
    });
  });
});

describe('export links and the review text', () => {
  it('builds the download address', () => {
    expect(exportUrl('abc-1', 'docx', false)).toBe('/api/runs/abc-1/export?format=docx');
    expect(exportUrl('abc-1', 'csv', true)).toBe('/api/runs/abc-1/export?format=csv&approved=true');
  });

  it('says what QA did and how much of the draft survived', () => {
    const stats = {
      generated: 4,
      kept: 2,
      edited: 1,
      deleted: 1,
      added: 2,
      approved: 3,
      total: 5,
      keptShare: 0.75,
    };

    expect(reviewText(stats)).toBe('2 kept, 1 edited, 1 deleted, 2 added');
    expect(keptShareText(stats)).toBe('75%');
    expect(keptShareText({ ...stats, generated: 0, keptShare: 0 })).toBe('-');
  });
});
