export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

/**
 * Database changes, in order. Never edit a migration that has been applied anywhere:
 * add a new one. Each has an "up" (apply) and a "down" (undo).
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: `
      CREATE TABLE runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        input_mode text NOT NULL,
        input_value text NOT NULL,
        filters jsonb NOT NULL DEFAULT '{}'::jsonb,
        prompt_version text NOT NULL,
        model text,
        flow_source text,
        warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
        input_tokens integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        total_tokens integer NOT NULL DEFAULT 0,
        calls integer NOT NULL DEFAULT 0,
        estimated_cost_usd numeric(12, 6),
        duration_ms integer,
        error text
      );
      CREATE INDEX runs_created_at_idx ON runs (created_at DESC);

      CREATE TABLE run_tickets (
        run_id uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        ticket_key text NOT NULL,
        position integer NOT NULL,
        status text NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
        cases integer NOT NULL DEFAULT 0,
        attempts integer,
        reviewed boolean,
        cached boolean NOT NULL DEFAULT false,
        model text,
        review_note text,
        error text,
        detail jsonb,
        PRIMARY KEY (run_id, ticket_key)
      );

      CREATE TABLE flow_steps (
        run_id uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        position integer NOT NULL,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        PRIMARY KEY (run_id, position)
      );

      CREATE TABLE test_cases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
        code text NOT NULL,
        ticket_key text NOT NULL,
        position integer NOT NULL,
        flow_step text NOT NULL,
        title text NOT NULL,
        type text NOT NULL CHECK (type IN ('unit', 'api', 'ui')),
        priority text NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
        steps jsonb NOT NULL,
        expected text NOT NULL,
        preconditions jsonb NOT NULL DEFAULT '[]'::jsonb,
        assumptions jsonb NOT NULL DEFAULT '[]'::jsonb,
        sources jsonb NOT NULL DEFAULT '[]'::jsonb,
        depends_on jsonb NOT NULL DEFAULT '[]'::jsonb,
        grounding text NOT NULL DEFAULT 'assumed' CHECK (grounding IN ('grounded', 'partly', 'assumed')),
        origin text NOT NULL DEFAULT 'generated' CHECK (origin IN ('generated', 'added')),
        edited boolean NOT NULL DEFAULT false,
        deleted boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (run_id, code)
      );
      CREATE INDEX test_cases_run_idx ON test_cases (run_id, position);

      CREATE TABLE case_revisions (
        id serial PRIMARY KEY,
        case_id uuid NOT NULL REFERENCES test_cases (id) ON DELETE CASCADE,
        revision integer NOT NULL,
        change_type text NOT NULL CHECK (change_type IN ('created', 'edited', 'deleted', 'restored')),
        changed_by text NOT NULL DEFAULT 'unknown',
        changed_at timestamptz NOT NULL DEFAULT now(),
        before jsonb,
        after jsonb,
        UNIQUE (case_id, revision)
      );

      CREATE TABLE ticket_cache (
        cache_key text PRIMARY KEY,
        ticket_key text NOT NULL,
        ticket_updated text NOT NULL,
        prompt_version text NOT NULL,
        model text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_hit_at timestamptz,
        hits integer NOT NULL DEFAULT 0
      );
      CREATE INDEX ticket_cache_ticket_idx ON ticket_cache (ticket_key);
    `,
    down: `
      DROP TABLE IF EXISTS ticket_cache;
      DROP TABLE IF EXISTS case_revisions;
      DROP TABLE IF EXISTS test_cases;
      DROP TABLE IF EXISTS flow_steps;
      DROP TABLE IF EXISTS run_tickets;
      DROP TABLE IF EXISTS runs;
    `,
  },
];
