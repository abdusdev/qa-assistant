import { z } from 'zod';
import type { Flow, TestCase } from '../ai/schemas.js';
import { CASE_TYPES, PRIORITIES } from '../ai/schemas.js';
import type { PipelineResult } from '../pipeline/run.js';
import type { Db } from './types.js';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type CaseState = 'generated' | 'edited' | 'deleted' | 'added';

export interface NewRun {
  mode: string;
  value: string;
  filters?: Record<string, unknown>;
  promptVersion: string;
}

export interface RunSummary {
  id: string;
  createdAt: Date;
  finishedAt: Date | null;
  status: RunStatus;
  inputMode: string;
  inputValue: string;
  promptVersion: string;
  model: string | null;
  totalTokens: number;
  /** Cases in the run that were not deleted. */
  caseCount: number;
  error: string | null;
}

export interface StoredTicket {
  ticket: string;
  position: number;
  status: 'ok' | 'failed' | 'skipped';
  cases: number;
  attempts: number | null;
  reviewed: boolean | null;
  cached: boolean;
  model: string | null;
  reviewNote: string | null;
  error: string | null;
  detail: { sufficient: boolean; missing: string[] } | null;
  /** The behaviours the model planned for this ticket, and the ones no case covers. */
  plan: { items: { id: string; behaviour: string }[]; uncovered: string[] } | null;
}

/** A case as stored: the AI's fields plus what QA did with it. */
export interface StoredCase extends TestCase {
  /** Stable database id. The `id` field is the human code, such as TC-3. */
  uid: string;
  runId: string;
  position: number;
  state: CaseState;
  updatedAt: Date;
}

export interface StoredRun extends RunSummary {
  filters: Record<string, unknown>;
  flowSource: string | null;
  warnings: string[];
  inputTokens: number;
  outputTokens: number;
  calls: number;
  estimatedCostUsd: number | null;
  durationMs: number | null;
  tickets: StoredTicket[];
  flow: { position: number; name: string; description: string; caseCodes: string[] }[];
  cases: StoredCase[];
}

export interface RunStats {
  /** Cases the AI produced for this run. */
  generated: number;
  /** AI cases QA left exactly as they were. */
  kept: number;
  /** AI cases QA changed. */
  edited: number;
  /** AI cases QA removed. */
  deleted: number;
  /** Cases QA added by hand. */
  added: number;
  /** Share of the AI's cases that survived (kept or edited), from 0 to 1. */
  keptShare: number;
}

const line = (max: number) => z.string().trim().min(1).max(max);

/**
 * The fields of a case QA may change. Every field is optional and has no default, so an edit
 * touches only the fields it names (a default here would silently reset the others).
 */
export const caseEditSchema = z
  .object({
    title: z.string().trim().min(5).max(200),
    type: z.enum(CASE_TYPES),
    priority: z.enum(PRIORITIES),
    steps: z.array(line(500)).min(1).max(30),
    expected: line(1000),
    preconditions: z.array(line(300)).max(10),
    assumptions: z.array(line(400)).max(10),
    flow_step: line(80),
  })
  .partial()
  .strict();

export type CaseEdit = z.infer<typeof caseEditSchema>;

export interface CacheEntry {
  cacheKey: string;
  ticketKey: string;
  ticketUpdated: string;
  promptVersion: string;
  model: string;
  payload: unknown;
}

const json = (value: unknown) => JSON.stringify(value);

interface RunRow {
  id: string;
  created_at: Date;
  finished_at: Date | null;
  status: RunStatus;
  input_mode: string;
  input_value: string;
  filters: Record<string, unknown>;
  prompt_version: string;
  model: string | null;
  flow_source: string | null;
  warnings: string[];
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  calls: number;
  estimated_cost_usd: string | null;
  duration_ms: number | null;
  error: string | null;
  case_count?: number;
}

interface CaseRow {
  id: string;
  run_id: string;
  code: string;
  ticket_key: string;
  position: number;
  flow_step: string;
  title: string;
  type: TestCase['type'];
  priority: TestCase['priority'];
  steps: string[];
  expected: string;
  preconditions: string[];
  assumptions: string[];
  sources: TestCase['sources'];
  depends_on: string[];
  covers: string[];
  grounding: TestCase['grounding'];
  origin: 'generated' | 'added';
  edited: boolean;
  deleted: boolean;
  updated_at: Date;
}

const stateOf = (row: Pick<CaseRow, 'origin' | 'edited' | 'deleted'>): CaseState => {
  if (row.deleted) return 'deleted';
  if (row.origin === 'added') return 'added';
  return row.edited ? 'edited' : 'generated';
};

const toCase = (row: CaseRow): StoredCase => ({
  uid: row.id,
  runId: row.run_id,
  id: row.code,
  ticket: row.ticket_key,
  position: row.position,
  flow_step: row.flow_step,
  title: row.title,
  type: row.type,
  priority: row.priority,
  steps: row.steps,
  expected: row.expected,
  preconditions: row.preconditions,
  assumptions: row.assumptions,
  sources: row.sources,
  depends_on: row.depends_on,
  covers: row.covers,
  grounding: row.grounding,
  state: stateOf(row),
  updatedAt: row.updated_at,
});

const toSummary = (row: RunRow): RunSummary => ({
  id: row.id,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
  status: row.status,
  inputMode: row.input_mode,
  inputValue: row.input_value,
  promptVersion: row.prompt_version,
  model: row.model,
  totalTokens: row.total_tokens,
  caseCount: row.case_count ?? 0,
  error: row.error,
});

const EDITABLE: (keyof CaseEdit)[] = [
  'title',
  'type',
  'priority',
  'steps',
  'expected',
  'preconditions',
  'assumptions',
  'flow_step',
];

const snapshot = (row: CaseRow) =>
  Object.fromEntries(EDITABLE.map((field) => [field, row[field as keyof CaseRow]]));

/** Everything the app stores: runs, their cases, QA's edits and the per-ticket result cache. */
export class Repository {
  constructor(private readonly db: Db) {}

  // ---- runs -------------------------------------------------------------------------------

  async createRun(input: NewRun): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO runs (status, input_mode, input_value, filters, prompt_version)
       VALUES ('running', $1, $2, $3::jsonb, $4) RETURNING id`,
      [input.mode, input.value, json(input.filters ?? {}), input.promptVersion],
    );
    return (rows[0] as { id: string }).id;
  }

  /** Stores a finished run: its tickets, cases, flow, warnings and totals, all or nothing. */
  async saveResult(runId: string, result: PipelineResult): Promise<void> {
    await this.db.transaction(async (tx) => {
      const model = result.tickets.find((t) => t.model)?.model ?? null;

      const updated = await tx.query(
        `UPDATE runs SET status = $2, finished_at = now(), model = $3, flow_source = $4,
           warnings = $5::jsonb, input_tokens = $6, output_tokens = $7, total_tokens = $8,
           calls = $9, estimated_cost_usd = $10, duration_ms = $11, prompt_version = $12
         WHERE id = $1`,
        [
          runId,
          result.cancelled ? 'cancelled' : 'completed',
          model,
          result.flowSource,
          json(result.warnings),
          result.usage.inputTokens,
          result.usage.outputTokens,
          result.usage.totalTokens,
          result.calls,
          result.estimatedCostUsd ?? null,
          Math.round(result.durationMs),
          result.promptVersion,
        ],
      );
      if (updated.rowCount === 0) throw new Error(`Run ${runId} does not exist.`);

      for (const [position, ticket] of result.tickets.entries()) {
        await tx.query(
          `INSERT INTO run_tickets (run_id, ticket_key, position, status, cases, attempts, reviewed,
             cached, model, review_note, error, detail, plan)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)`,
          [
            runId,
            ticket.ticket,
            position,
            ticket.status,
            ticket.cases,
            ticket.attempts ?? null,
            ticket.reviewed ?? null,
            ticket.cached ?? false,
            ticket.model ?? null,
            ticket.reviewNote ?? null,
            ticket.error ?? null,
            ticket.detail ? json(ticket.detail) : null,
            ticket.plan ? json(ticket.plan) : null,
          ],
        );
      }

      for (const [position, step] of result.flow.steps.entries()) {
        await tx.query(
          'INSERT INTO flow_steps (run_id, position, name, description) VALUES ($1, $2, $3, $4)',
          [runId, position, step.name, step.description],
        );
      }

      for (const [position, testCase] of result.cases.entries()) {
        await this.insertCase(tx, runId, testCase, position, 'generated');
      }
    });
  }

  async failRun(runId: string, message: string): Promise<void> {
    await this.db.query(
      `UPDATE runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
      [runId, message.slice(0, 2000)],
    );
  }

  async listRuns(limit = 20, offset = 0): Promise<RunSummary[]> {
    const { rows } = await this.db.query<RunRow>(
      `SELECT r.*, (SELECT count(*)::int FROM test_cases c WHERE c.run_id = r.id AND NOT c.deleted) AS case_count
       FROM runs r ORDER BY r.created_at DESC, r.id LIMIT $1 OFFSET $2`,
      [Math.min(Math.max(1, limit), 200), Math.max(0, offset)],
    );
    return rows.map(toSummary);
  }

  async getRun(runId: string): Promise<StoredRun | undefined> {
    const { rows } = await this.db.query<RunRow>('SELECT * FROM runs WHERE id = $1', [runId]);
    const row = rows[0];
    if (!row) return undefined;

    const tickets = await this.db.query<{
      ticket_key: string;
      position: number;
      status: StoredTicket['status'];
      cases: number;
      attempts: number | null;
      reviewed: boolean | null;
      cached: boolean;
      model: string | null;
      review_note: string | null;
      error: string | null;
      detail: StoredTicket['detail'];
      plan: StoredTicket['plan'];
    }>('SELECT * FROM run_tickets WHERE run_id = $1 ORDER BY position', [runId]);

    const steps = await this.db.query<{ position: number; name: string; description: string }>(
      'SELECT position, name, description FROM flow_steps WHERE run_id = $1 ORDER BY position',
      [runId],
    );
    const cases = await this.db.query<CaseRow>(
      'SELECT * FROM test_cases WHERE run_id = $1 ORDER BY position',
      [runId],
    );
    const stored = cases.rows.map(toCase);

    return {
      ...toSummary({ ...row, case_count: stored.filter((c) => c.state !== 'deleted').length }),
      filters: row.filters,
      flowSource: row.flow_source,
      warnings: row.warnings,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      calls: row.calls,
      estimatedCostUsd: row.estimated_cost_usd === null ? null : Number(row.estimated_cost_usd),
      durationMs: row.duration_ms,
      tickets: tickets.rows.map((t) => ({
        ticket: t.ticket_key,
        position: t.position,
        status: t.status,
        cases: t.cases,
        attempts: t.attempts,
        reviewed: t.reviewed,
        cached: t.cached,
        model: t.model,
        reviewNote: t.review_note,
        error: t.error,
        detail: t.detail,
        plan: t.plan,
      })),
      flow: steps.rows.map((step) => ({
        ...step,
        caseCodes: stored.filter((c) => c.flow_step === step.name).map((c) => c.id),
      })),
      cases: stored,
    };
  }

  // ---- QA's edits ----------------------------------------------------------------------------

  private async insertCase(
    db: Db,
    runId: string,
    testCase: TestCase,
    position: number,
    origin: 'generated' | 'added',
  ): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO test_cases (run_id, code, ticket_key, position, flow_step, title, type, priority,
         steps, expected, preconditions, assumptions, sources, depends_on, covers, grounding, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13::jsonb,
         $14::jsonb, $15::jsonb, $16, $17)
       RETURNING id`,
      [
        runId,
        testCase.id,
        testCase.ticket,
        position,
        testCase.flow_step,
        testCase.title,
        testCase.type,
        testCase.priority,
        json(testCase.steps),
        testCase.expected,
        json(testCase.preconditions),
        json(testCase.assumptions),
        json(testCase.sources),
        json(testCase.depends_on),
        json(testCase.covers ?? []),
        testCase.grounding,
        origin,
      ],
    );
    const uid = (rows[0] as { id: string }).id;
    await this.addRevision(
      db,
      uid,
      'created',
      'system',
      null,
      snapshot(await this.caseRow(db, uid)),
    );
    return uid;
  }

  private async caseRow(db: Db, uid: string): Promise<CaseRow> {
    const { rows } = await db.query<CaseRow>('SELECT * FROM test_cases WHERE id = $1', [uid]);
    const row = rows[0];
    if (!row) throw new Error(`Case ${uid} does not exist.`);
    return row;
  }

  private async addRevision(
    db: Db,
    uid: string,
    type: 'created' | 'edited' | 'deleted' | 'restored',
    by: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await db.query(
      `INSERT INTO case_revisions (case_id, revision, change_type, changed_by, before, after)
       VALUES ($1, (SELECT COALESCE(MAX(revision), 0) + 1 FROM case_revisions WHERE case_id = $1),
         $2, $3, $4::jsonb, $5::jsonb)`,
      [uid, type, by, before === null ? null : json(before), after === null ? null : json(after)],
    );
  }

  /** Changes a case. Returns undefined when it does not exist. Unknown fields are rejected. */
  async updateCase(
    uid: string,
    edit: CaseEdit,
    changedBy = 'unknown',
  ): Promise<StoredCase | undefined> {
    const patch = caseEditSchema.parse(edit);
    const keys = Object.keys(patch) as (keyof CaseEdit)[];

    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<CaseRow>(
        'SELECT * FROM test_cases WHERE id = $1 FOR UPDATE',
        [uid],
      );
      const before = rows[0];
      if (!before) return undefined;
      if (keys.length === 0) return toCase(before);

      const sets = keys.map((key, index) => {
        const isJson = ['steps', 'preconditions', 'assumptions'].includes(key);
        return `${key} = $${index + 2}${isJson ? '::jsonb' : ''}`;
      });
      const values = keys.map((key) => {
        const value = patch[key];
        return ['steps', 'preconditions', 'assumptions'].includes(key) ? json(value) : value;
      });

      await tx.query(
        `UPDATE test_cases SET ${sets.join(', ')}, edited = true, updated_at = now() WHERE id = $1`,
        [uid, ...values],
      );
      const after = await this.caseRow(tx, uid);
      await this.addRevision(tx, uid, 'edited', changedBy, snapshot(before), snapshot(after));
      return toCase(after);
    });
  }

  async deleteCase(uid: string, changedBy = 'unknown'): Promise<boolean> {
    return this.setDeleted(uid, true, changedBy);
  }

  async restoreCase(uid: string, changedBy = 'unknown'): Promise<boolean> {
    return this.setDeleted(uid, false, changedBy);
  }

  private async setDeleted(uid: string, deleted: boolean, changedBy: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<CaseRow>(
        'SELECT * FROM test_cases WHERE id = $1 FOR UPDATE',
        [uid],
      );
      const row = rows[0];
      if (!row) return false;
      if (row.deleted === deleted) return true;

      await tx.query('UPDATE test_cases SET deleted = $2, updated_at = now() WHERE id = $1', [
        uid,
        deleted,
      ]);
      await this.addRevision(
        tx,
        uid,
        deleted ? 'deleted' : 'restored',
        changedBy,
        snapshot(row),
        snapshot(row),
      );
      return true;
    });
  }

  /** Adds a case by hand to the end of a run. It gets the next free TC number. */
  async addCase(
    runId: string,
    input: Omit<TestCase, 'id' | 'grounding' | 'sources' | 'depends_on'> &
      Partial<Pick<TestCase, 'sources' | 'depends_on'>>,
    changedBy = 'unknown',
  ): Promise<StoredCase> {
    return this.db.transaction(async (tx) => {
      const next = await tx.query<{ position: number; number: number }>(
        `SELECT COALESCE(MAX(position) + 1, 0)::int AS position,
                COALESCE(MAX(NULLIF(regexp_replace(code, '[^0-9]', '', 'g'), '')::int), 0)::int + 1 AS number
         FROM test_cases WHERE run_id = $1`,
        [runId],
      );
      const { position, number } = next.rows[0] as { position: number; number: number };

      const testCase: TestCase = {
        ...input,
        id: `TC-${number}`,
        sources: input.sources ?? [],
        depends_on: input.depends_on ?? [],
        grounding: 'assumed',
      };
      const uid = await this.insertCase(tx, runId, testCase, position, 'added');
      await tx.query(
        `UPDATE case_revisions SET changed_by = $2 WHERE case_id = $1 AND change_type = 'created'`,
        [uid, changedBy],
      );
      return toCase(await this.caseRow(tx, uid));
    });
  }

  async revisions(uid: string) {
    const { rows } = await this.db.query<{
      revision: number;
      change_type: string;
      changed_by: string;
      changed_at: Date;
      before: unknown;
      after: unknown;
    }>('SELECT * FROM case_revisions WHERE case_id = $1 ORDER BY revision', [uid]);
    return rows.map((row) => ({
      revision: row.revision,
      type: row.change_type,
      by: row.changed_by,
      at: row.changed_at,
      before: row.before,
      after: row.after,
    }));
  }

  /** How much of the AI's draft survived QA's review. */
  async runStats(runId: string): Promise<RunStats> {
    const { rows } = await this.db.query<{
      generated: number;
      kept: number;
      edited: number;
      deleted: number;
      added: number;
    }>(
      `SELECT
         count(*) FILTER (WHERE origin = 'generated')::int AS generated,
         count(*) FILTER (WHERE origin = 'generated' AND NOT edited AND NOT deleted)::int AS kept,
         count(*) FILTER (WHERE origin = 'generated' AND edited AND NOT deleted)::int AS edited,
         count(*) FILTER (WHERE origin = 'generated' AND deleted)::int AS deleted,
         count(*) FILTER (WHERE origin = 'added' AND NOT deleted)::int AS added
       FROM test_cases WHERE run_id = $1`,
      [runId],
    );
    const stats = rows[0] as Omit<RunStats, 'keptShare'>;
    return {
      ...stats,
      keptShare: stats.generated === 0 ? 0 : (stats.kept + stats.edited) / stats.generated,
    };
  }

  // ---- result cache ----------------------------------------------------------------------------

  async cacheGet<T>(cacheKey: string): Promise<T | undefined> {
    const { rows } = await this.db.query<{ payload: T }>(
      `UPDATE ticket_cache SET hits = hits + 1, last_hit_at = now()
       WHERE cache_key = $1 RETURNING payload`,
      [cacheKey],
    );
    return rows[0]?.payload;
  }

  async cachePut(entry: CacheEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO ticket_cache (cache_key, ticket_key, ticket_updated, prompt_version, model, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
      [
        entry.cacheKey,
        entry.ticketKey,
        entry.ticketUpdated,
        entry.promptVersion,
        entry.model,
        json(entry.payload),
      ],
    );
  }

  // ---- retention ---------------------------------------------------------------------------------

  /** Deletes runs, and cache entries, older than the given number of days. */
  async purgeOlderThan(days: number): Promise<{ runs: number; cacheEntries: number }> {
    const interval = `${Math.max(0, Math.floor(days))} days`;
    const runs = await this.db.query(`DELETE FROM runs WHERE created_at < now() - $1::interval`, [
      interval,
    ]);
    const cache = await this.db.query(
      `DELETE FROM ticket_cache WHERE COALESCE(last_hit_at, created_at) < now() - $1::interval`,
      [interval],
    );
    return { runs: runs.rowCount, cacheEntries: cache.rowCount };
  }
}

/** The flow stored with a run, in the same shape the pipeline produces. */
export function flowOf(run: StoredRun): Flow {
  return {
    steps: run.flow.map((step) => ({
      order: step.position + 1,
      name: step.name,
      description: step.description,
      caseIds: step.caseCodes,
    })),
  };
}
