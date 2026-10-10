import { describe, expect, it } from 'vitest';
import { buildJql, quoteJql } from '../../../src/jira/jql.js';

describe('quoteJql', () => {
  it('wraps a value in double quotes', () => {
    expect(quoteJql('SN - Sprint 45')).toBe('"SN - Sprint 45"');
  });

  it('escapes quotes and backslashes', () => {
    expect(quoteJql('Team "A" \\ B')).toBe('"Team \\"A\\" \\\\ B"');
  });

  it('cannot be broken out of with a closing quote', () => {
    expect(quoteJql('x" OR project = "Y')).toBe('"x\\" OR project = \\"Y"');
  });

  it('turns new lines and tabs into spaces', () => {
    expect(quoteJql('line one\nline\ttwo')).toBe('"line one line two"');
  });

  it('rejects empty and over-long values', () => {
    expect(() => quoteJql('   ', 'sprint name')).toThrow(/sprint name is empty/);
    expect(() => quoteJql('x'.repeat(256))).toThrow(/too long/);
  });
});

describe('buildJql', () => {
  it('builds the sprint query', () => {
    expect(buildJql('sprint', 'SN - Sprint 45')).toBe('sprint = "SN - Sprint 45" ORDER BY key ASC');
  });

  it('builds the epic query from its key', () => {
    expect(buildJql('epic', ' shp-4084 ')).toBe('parent = SHP-4084 ORDER BY key ASC');
  });

  it('builds the release query', () => {
    expect(buildJql('release', '2.14.0')).toBe('fixVersion = "2.14.0" ORDER BY key ASC');
  });

  it('adds issue type and status filters', () => {
    const jql = buildJql('sprint', 'SN - Sprint 45', {
      types: ['Story', 'Bug', 'Task'],
      statuses: ['Done', 'READY FOR QA'],
    });
    expect(jql).toBe(
      'sprint = "SN - Sprint 45" AND issuetype in ("Story", "Bug", "Task") ' +
        'AND status in ("Done", "READY FOR QA") ORDER BY key ASC',
    );
  });

  it('adds only the filters that are given', () => {
    expect(buildJql('epic', 'SHP-4084', { statuses: ['Done'] })).toBe(
      'parent = SHP-4084 AND status in ("Done") ORDER BY key ASC',
    );
  });

  it('ignores empty filter lists and blank entries', () => {
    expect(buildJql('epic', 'SHP-4084', { types: [], statuses: ['  ', ''] })).toBe(
      'parent = SHP-4084 ORDER BY key ASC',
    );
  });

  it('escapes filter values too', () => {
    expect(buildJql('epic', 'SHP-4084', { statuses: ['Done" OR 1=1'] })).toBe(
      'parent = SHP-4084 AND status in ("Done\\" OR 1=1") ORDER BY key ASC',
    );
  });

  it('rejects an epic value that is not a ticket key', () => {
    expect(() => buildJql('epic', 'not a key')).toThrow(/not a valid epic key/);
    expect(() => buildJql('epic', 'SHP-1 OR project = X')).toThrow(/not a valid epic key/);
  });

  it('rejects an empty sprint name', () => {
    expect(() => buildJql('sprint', '  ')).toThrow(/sprint name is empty/);
  });
});
