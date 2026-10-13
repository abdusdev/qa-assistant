import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadEvalFile } from '../ai/eval-file.js';
import type { SearchOptions, SearchResult } from './client.js';
import { JiraError } from './errors.js';
import type { Ticket } from './ticket.js';
import type { TicketSource } from './resolver.js';

/**
 * Tickets read from JSON files instead of Jira, in the format of evals/tickets. Used to run the
 * whole system offline (tests, demos). Searches ignore the query and return every file.
 */
export class FixtureTicketSource implements TicketSource {
  /** The files are read once. Callers that arrive while it is going wait for the same read. */
  private loading: Promise<Ticket[]> | undefined;

  constructor(private readonly directory: string) {}

  private tickets(): Promise<Ticket[]> {
    this.loading ??= (async () => {
      const names = (await readdir(this.directory)).filter((n) => n.endsWith('.json')).sort();
      const tickets: Ticket[] = [];
      for (const name of names) {
        const { ticket } = await loadEvalFile(path.join(this.directory, name));
        tickets.push(ticket);
      }
      return tickets;
    })();
    return this.loading;
  }

  async getIssue(rawKey: string): Promise<Ticket> {
    const key = rawKey.trim().toUpperCase();
    const found = (await this.tickets()).find((ticket) => ticket.key.toUpperCase() === key);
    if (!found) {
      throw new JiraError(
        'not_found',
        `Ticket ${key} was not found in the fixture tickets (404).`,
        404,
      );
    }
    return found;
  }

  async searchIssues(_jql: string, options: SearchOptions = {}): Promise<SearchResult> {
    const all = await this.tickets();
    const max = Math.max(1, options.maxTickets ?? 100);
    return { tickets: all.slice(0, max), truncated: all.length > max };
  }
}
