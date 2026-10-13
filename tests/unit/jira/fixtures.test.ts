import { describe, expect, it } from 'vitest';
import { JiraError } from '../../../src/jira/errors.js';
import { FixtureTicketSource } from '../../../src/jira/fixtures.js';
import { resolveInput } from '../../../src/jira/resolver.js';

const source = () => new FixtureTicketSource('evals/tickets');

describe('FixtureTicketSource', () => {
  it('reads tickets from the files, whatever the letter case of the key', async () => {
    const ticket = await source().getIssue(' eval-1 ');

    expect(ticket.key).toBe('EVAL-1');
    expect(ticket.summary).toBeTruthy();
  });

  it('answers not found for a key that has no file', async () => {
    const error = await source()
      .getIssue('EVAL-99')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JiraError);
    expect((error as JiraError).kind).toBe('not_found');
  });

  it('returns every file for a search, up to the limit', async () => {
    const all = await source().searchIssues('project = X');
    const one = await source().searchIssues('project = X', { maxTickets: 1 });

    expect(all.tickets.length).toBeGreaterThanOrEqual(3);
    expect(all.truncated).toBe(false);
    expect(one.tickets).toHaveLength(1);
    expect(one.truncated).toBe(true);
  });

  it('answers callers that arrive while the folder is being read, not from a half-read one', async () => {
    const shared = source();

    // Callers arrive one event-loop turn apart, so some land in the middle of the first read.
    const answers: Promise<string>[] = [];
    for (let i = 0; i < 40; i++) {
      answers.push(shared.getIssue(i % 2 === 0 ? 'EVAL-1' : 'EVAL-2').then((ticket) => ticket.key));
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(await Promise.all(answers)).toEqual(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 'EVAL-1' : 'EVAL-2')),
    );
  });

  it('works with the input resolver', async () => {
    const resolved = await resolveInput(source(), { mode: 'list', value: 'EVAL-1 EVAL-2' });

    expect(resolved.tickets.map((t) => t.key)).toEqual(['EVAL-1', 'EVAL-2']);
  });
});
