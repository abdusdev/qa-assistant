# qa-assistant

Internal tool that turns Jira tickets and code changes into draft test cases and a test flow for QA review, using an AI API, GitHub context and a Jira connection.

The tool produces **draft test cases and a flow for QA to review and edit**. It does not generate test code, and its output is never final.

## Status

Early development. Work is tracked in GitHub issues and Jira epic SHP-4110.

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

| Command                                                             | What it does                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                                       | Start the server with auto-reload                                                                          |
| `npm start`                                                         | Start the server                                                                                           |
| `npm test`                                                          | Run unit tests (Vitest)                                                                                    |
| `npm run test:coverage`                                             | Run unit tests with the 80% coverage threshold                                                             |
| `npm run test:e2e`                                                  | Run end-to-end tests (Playwright)                                                                          |
| `npm run lint`                                                      | Lint the code                                                                                              |
| `npm run format`                                                    | Format the code (`format:check` only checks)                                                               |
| `npm run typecheck`                                                 | Type-check the code                                                                                        |
| `npm run check`                                                     | Everything CI runs: lint, format, types, unit and e2e                                                      |
| `npm run pipeline -- file evals/tickets/example-bulk-shipment.json` | Run the whole pipeline by hand: tickets in, cases and flow out                                             |
| `npm run knowledge -- check`                                        | Check the knowledge folder (also `match SHP-1234`, `import-cases file.csv`, `components`)                  |
| `npm run github -- context SHP-1234`                                | Show the pull request code text that would be sent for a ticket (no AI call; also `check`, `find`)         |
| `npm run digest -- list app_2/src/modules`                          | Draft code overviews of modules for review (also `plan`, `generate`; needs `--allow-code-to-ai`)           |
| `npm run db -- migrate`                                             | Create or update the database tables (also `status`, `rollback`, `purge`, `runs`)                          |
| `npm run eval`                                                      | Run the real AI on the tickets in `evals/tickets` and compare with QA reference cases (by hand, not in CI) |
| `npm run ai:check`                                                  | Make one tiny call to the AI provider set in `.env` and print the answer and token use                     |
| `npm run jira:check`                                                | Check that the Jira settings in `.env` work (who you are, can you see the project)                         |
| `npm run jira:resolve -- epic SHP-4110`                             | Resolve an input (ticket, list, sprint, epic, release) to tickets, with `--type`, `--status`, `--max`      |
| `npm run jira:ticket -- SHP-1234`                                   | Print a Jira ticket as the AI will see it (needs Jira settings in `.env`)                                  |

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

1. Set `GITHUB_TOKEN` (a read-only token) and `GITHUB_REPOS` (`owner/name`, comma-separated) in `.env`.
2. `npm run github -- check` confirms the token can read the repositories.
3. `npm run github -- context SHP-1234` prints exactly the code text that would be sent. It makes no AI call.
4. `npm run pipeline -- ... --code-context --allow-code-to-ai` uses it. Source code goes to the AI provider, so the
   second flag is required: on the free Gemini tier Google may use that content. Get approval or use the paid tier.

A ticket with no pull request is generated from its own text, with a warning. A code overview of a whole module
can be drafted with `npm run digest` and is used only after a person has reviewed it (see `knowledge/README.md`).

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
