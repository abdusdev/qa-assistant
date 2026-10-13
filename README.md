# qa-assistant

Internal tool that turns Jira tickets and code changes into draft test cases and a test flow for QA review, using an AI API, GitHub context and a Jira connection.

The tool produces **draft test cases and a flow for QA to review and edit**. It does not generate test code, and its output is never final.

## Status

The engine works from the command line: Jira tickets in, draft test cases and a test flow out, with
product knowledge and pull request code as context. The HTTP API, the web interface, export and the
pilot are still to come. Work is tracked in GitHub issues (milestones M1 to M5 and Pilot) and Jira
epic SHP-4110. See `docs/architecture.md` for how a run flows and `CONTRIBUTING.md` for how to work
in this repository.

## Requirements

- Node.js 22 or newer
- npm

## Setup

```bash
npm ci
cp .env.example .env   # then fill in the values you need
```

Settings are read from environment variables (see `.env.example`). Missing or invalid settings stop the app at startup with a message that names the setting. Never commit `.env`.

## Scripts

| Command                                                                    | What it does                                                                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                                              | Start the server with auto-reload                                                                           |
| `npm start`                                                                | Start the server                                                                                            |
| `npm test`                                                                 | Run unit tests (Vitest)                                                                                     |
| `npm run test:coverage`                                                    | Run unit tests with the 80% coverage threshold                                                              |
| `npm run test:e2e`                                                         | Run end-to-end tests (Playwright)                                                                           |
| `npm run lint`                                                             | Lint the code                                                                                               |
| `npm run format`                                                           | Format the code (`format:check` only checks)                                                                |
| `npm run typecheck`                                                        | Type-check the code                                                                                         |
| `npm run check`                                                            | Everything CI runs: lint, format, types, unit and e2e                                                       |
| `npm run pipeline -- file evals/tickets/example-bulk-shipment.json`        | Run the whole pipeline by hand: tickets in, cases and flow out                                              |
| `npm run knowledge -- check`                                               | Check the knowledge folder (also `match SHP-1234`, `import-cases file.csv`, `components`)                   |
| `npm run github -- context SHP-1234`                                       | Show the pull request code text that would be sent for a ticket (no AI call; also `check`, `find`)          |
| `npm run digest -- list app_2/src/modules`                                 | Draft code overviews of modules for review (also `plan`, `generate`; needs `--allow-code-to-ai`)            |
| `npm run export -- file out/pipeline-....json --format docx --author Tech` | Export a result (or a saved run: `export -- run <id>`) as Word, Markdown or CSV, with the "AI draft" notice |
| `npm run db -- migrate`                                                    | Create or update the database tables (also `status`, `rollback`, `purge`, `runs`)                           |
| `npm run eval`                                                             | Run the real AI on the tickets in `evals/tickets` and compare with QA reference cases (by hand, not in CI)  |
| `npm run ai:check`                                                         | Make one tiny call to the AI provider set in `.env` and print the answer and token use                      |
| `npm run jira:check`                                                       | Check that the Jira settings in `.env` work (who you are, can you see the project)                          |
| `npm run jira:resolve -- epic SHP-4110`                                    | Resolve an input (ticket, list, sprint, epic, release) to tickets, with `--type`, `--status`, `--max`       |
| `npm run jira:ticket -- SHP-1234`                                          | Print a Jira ticket as the AI will see it (needs Jira settings in `.env`)                                   |

First time running the end-to-end tests: `npx playwright install chromium`.

## Folder structure

| Folder         | Purpose                                   |
| -------------- | ----------------------------------------- |
| `src/config`   | Settings loader and validation            |
| `src/server`   | HTTP server and routes                    |
| `src/jira`     | Jira client and ticket text conversion    |
| `src/ai`       | AI provider interface and implementations |
| `src/pipeline` | Test case generation pipeline             |
| `src/github`   | GitHub pull request and code context      |
| `src/db`       | Database access                           |
| `knowledge/`   | Product knowledge files used in prompts   |
| `web/`         | Frontend                                  |
| `tests/unit/`  | Unit tests (Vitest), mirroring `src/`     |
| `tests/e2e/`   | End-to-end tests (Playwright)             |
| `docs/`        | Project plan and notes                    |

## Knowledge

The AI writes better cases when it knows the product. Put the product overview, glossary, module notes and
approved past cases in `knowledge/` (see `knowledge/README.md`). Until those files are filled in, it works from
the ticket alone. `npm run knowledge -- check` shows what is missing.

## Code context

The AI can also see what changed in the code for a ticket. It finds the pull requests that mention the ticket key
(title, branch name or description), drops lockfiles, generated and private files, replaces anything that looks
like a secret, and adds the changed lines and the pull request description to the prompt.

It is **on by default** for every real run (tickets from Jira), so the code is never quietly missing.

1. In `.env` set `GITHUB_TOKEN` (a read-only token), `GITHUB_REPOS` (`owner/name`, comma-separated) and
   `ALLOW_CODE_TO_AI=true`. The last one is you agreeing that source code goes to the AI provider: on the free
   Gemini tier Google may use that content, so get approval or use the paid tier first.
2. `npm run github -- check` confirms the token can read the repositories.
3. `npm run github -- context SHP-1234` prints exactly the code text that would be sent. It makes no AI call.
4. `npm run pipeline -- ticket SHP-1234 --allow-real-tickets` now includes it.

Without `ALLOW_CODE_TO_AI` the run **stops** with an explanation instead of leaving the code out unnoticed.
Per run: `--no-code-context` leaves it out, `--allow-code-to-ai` agrees for that run only. `CODE_CONTEXT=false` in
`.env` turns it off everywhere. Example ticket files never use it, and a missing `GITHUB_TOKEN` is reported as a
warning at the top of the run.

**One prompt, one call.** `--single-call` sends the ticket, the product knowledge and the code changes in one prompt
and makes one AI call per ticket (no self-review, no AI ordering of the flow, which is grouped by each case's own
step). It uses about half the tokens. Without it a ticket makes three calls: generate, review (the same prompt plus
the draft) and flow (case titles only). `--print-prompt` prints the exact prompt for each ticket and sends nothing.

A ticket with no pull request is generated from its own text, with a warning. A code overview of a whole module
can be drafted with `npm run digest` and is used only after a person has reviewed it (see `knowledge/README.md`).

## Plan and checks

- **Plan first, in the same call.** The model lists every behaviour it finds in the ticket and the code (`plan`,
  B1, B2...) and then writes at least one case per item (`covers`). A planned behaviour with no case is listed as a
  warning. No extra AI call is made, which matters because Gemini's free tier limits requests per day.
- **Most relevant code first.** Changed files are ranked by how many of the ticket's words appear in their path and
  changed lines, so a relevant test file comes before a large unrelated one. Each run reports which files were shown.
- **Invented details are flagged.** An HTTP status code, an endpoint path or a number (10 or more) in a case that is
  not in the ticket or the context is added to the case's "to confirm" list. A value one away from a number in the
  sources is allowed, since boundary cases are made that way. This catches invented values, not a real value used
  for the wrong thing, so review is still needed.
- The plan and the coverage of each case are saved with the run (`npm run db -- migrate` adds the columns).

## API

`npm run dev` (or `npm start`) serves the generate API next to `GET /health`. Starting a run returns at once
with a job id, because a sprint can take minutes; the job is then read while it runs.

| Request                              | What it does                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/generate`                 | Start a run. Body: `mode` (`ticket`, `list`, `sprint`, `epic`, `release`), `value`, optional `filters` (`types`, `statuses`), `max`, `useCodeContext`, `selfReview`. Answers `202` with `jobId` |
| `GET /api/jobs/:id`                  | Status (`queued`, `running`, `done`, `failed`, `cancelled`), progress per ticket and, when done, the cases and flow                                                                             |
| `GET /api/jobs`                      | Recent jobs, without their results                                                                                                                                                              |
| `POST /api/jobs/:id/cancel`          | Stop a job. A cancelled job makes no new AI calls                                                                                                                                               |
| `GET /api/runs`, `GET /api/runs/:id` | Saved runs and their cases (needs `DATABASE_URL`)                                                                                                                                               |

Errors always look like `{ "error": { "code": "invalid_request", "message": "...", "details": [{ "field": "value", "problem": "..." }] } }`.

- **Access:** set `API_TOKEN` and every `/api` request must send `Authorization: Bearer <token>`. Without it the
  API is open to anyone who can reach the server, so set it before exposing the server.
- **Limits:** `MAX_CONCURRENT_RUNS` (default 1) runs at the same time; the rest wait in the queue. Jobs are kept in
  memory; a finished run is also saved when a database is set.
- **Code context:** the same rules as the command line. Without `ALLOW_CODE_TO_AI=true` a request that would use
  code is refused with `400 not_allowed`; send `"useCodeContext": false` to leave the code out.
- **Offline:** `AI_PROVIDER=fake` answers with small predictable cases, `TICKET_FIXTURES_DIR=evals/tickets` reads
  tickets from files instead of Jira, and `DATABASE_URL=pglite://memory` keeps history in memory. The end-to-end
  tests run this way, with no network.

```bash
curl -X POST localhost:3000/api/generate -H 'content-type: application/json'   -d '{"mode":"ticket","value":"SHP-4103","useCodeContext":false}'
curl localhost:3000/api/jobs/<jobId>
```

## Export

`npm run export` writes a run as a document for people who do not read JSON:

- **`docx`** (Word): notice, summary, what the cases cover, the flow, then every case with its steps, expected
  result, what it is based on and what to confirm. `--author` sets the author shown in the file.
- **`md`** (Markdown): the same content for an editor or a pull request.
- **`csv`**: one row per case in flow order for a spreadsheet (UTF-8 with a byte order mark so Excel reads it,
  and text that starts with `=`, `+`, `-` or `@` is neutralised so it cannot run as a formula).

Every export says it is an AI draft that needs QA review. In a CSV that is a column on every row, so it cannot be
separated from the cases. Cases QA deleted are left out, and each case shows whether it was kept, edited or
added. Cases are grouped by flow step, in flow order.

## Database

Set `DATABASE_URL` in `.env` to save runs and reuse results for tickets that have not changed:

- a Postgres server: `docker compose up -d`, then `DATABASE_URL=postgres://qa:qa@localhost:5432/qa_assistant`
- no server: `DATABASE_URL=pglite://./.data/qa-assistant` (a Postgres kept in a local folder)

The tables are created automatically by `npm run pipeline`, or by hand with `npm run db -- migrate`.
Runs and cached results older than `DB_RETENTION_DAYS` (default 90) are removed by `npm run db -- purge`.

## Workflow

1. Pick the next GitHub issue and its Jira ticket.
2. Branch from `main`, named after the Jira key: `SHP-4111-short-name`.
3. Build the change with its tests, then run `npm run check`.
4. Open a pull request with `Closes #N` in the description. CI must pass to merge.
