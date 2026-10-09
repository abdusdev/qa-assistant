# GitHub issues: QA Test Case Assistant

Each `## Issue N` section is one GitHub issue: the heading is the title, everything under it is the body.
Mirror each one in Jira as a story under epic **SHP-4084**, with the title prefix `[GH#N]`. Name branches `SHP-<key>-short-name`.

**Milestones**
| Milestone | Issues |
|---|---|
| M1 Foundation and Jira | 1, 2, 3 |
| M2 AI Generation | 4, 5, 6 |
| M3 Backend Platform | 7, 8 |
| M4 Knowledge and Code Context | 9, 10 |
| M5 UI and Release | 11, 12, 13 |
| Pilot (process) | 14 |

**Testing rule for every issue:** unit tests (Vitest) cover logic and run in CI. Playwright covers user-facing flows with a fake AI provider and mocked Jira. Real-AI quality is checked manually, not in CI. No issue is closed with a red CI.

**Product rule:** the tool produces draft test cases and a flow, never test code. Output is always labeled as an AI draft for QA review.

---

## Issue 1: Project foundation and CI

**Milestone:** M1 | **Labels:** `setup`, `ci`

**Goal**
A clean TypeScript project where every pull request automatically runs lint, typecheck, unit tests and Playwright tests, and a red build blocks merging.

**Tasks**
- [ ] Node 22, TypeScript (strict), ESLint + Prettier
- [ ] Folder structure: `src/server`, `src/jira`, `src/ai`, `src/pipeline`, `src/github`, `src/db`, `knowledge/`, `web/`, `docs/`
- [ ] Config loader that validates env vars with Zod and fails fast with a clear message
- [ ] `.env.example` (Jira, AI, GitHub, DB variables) and `.gitignore` (`.env`, `node_modules`, `out`)
- [ ] Vitest installed with a coverage threshold (80%)
- [ ] Playwright installed with one smoke test
- [ ] GitHub Actions workflow: install, lint, typecheck, unit tests, Playwright
- [ ] Branch protection on `main`: PR required, CI must pass
- [ ] PR template with a "Done when / tests / manual check" checklist
- [ ] README skeleton: purpose, setup, scripts

**Acceptance criteria**
- A PR with a deliberately failing test cannot be merged.
- A fresh clone plus `npm ci` plus `npm test` works on a clean machine.
- Missing env vars produce a readable error naming the variable.

**Tests**
- Unit: config validation (missing, malformed, defaults)
- Playwright: smoke test loads the app shell

**Manual check:** open a test PR and confirm the CI checks appear and block on failure.

**Dependencies:** none

---

## Issue 2: Jira client and ADF converter

**Milestone:** M1 | **Labels:** `jira`, `backend`

**Goal**
Fetch any ShipNest ticket from Jira Cloud and turn it into clean plain text the AI can read.

**Background**
Jira Cloud (`99technologies.atlassian.net`, project `SHP`). Descriptions and comments come back in Atlassian Document Format (ADF).

**Tasks**
- [ ] `JiraClient` with basic auth (email + API token from env, never logged)
- [ ] `getIssue(key)` for summary, description, status, issue type, comments, parent (epic), sprint, fix versions
- [ ] Optional acceptance-criteria custom field via `JIRA_AC_FIELD`
- [ ] ADF to text converter: paragraphs, headings, bullet/ordered/nested lists, task lists, code blocks, tables, panels, links, mentions, status, media placeholders
- [ ] Timeouts, retry with backoff on 429/5xx (respect `Retry-After`)
- [ ] Typed errors: unauthorized, not found, rate limited, network
- [ ] Normalized `Ticket` type (Zod schema) used by the rest of the app

**Acceptance criteria**
- A real ticket renders as readable text with lists and links intact.
- The API token never appears in logs or error messages.
- Failures give a clear, typed error.

**Tests**
- Unit: converter against fixture ADF for every node type, including unknown nodes
- Unit: client against recorded responses (200, 401, 404, 429 then 200, 500)
- Unit: the token is redacted from error output

**Manual check:** fetch 3 real SHP tickets (one story, one bug, one with a table or code block) and compare against Jira in the browser.

**Dependencies:** Issue 1. Needs a Jira API token (ask the Jira admin for a bot account).

---

## Issue 3: Ticket input resolver (key, list, sprint, epic)

**Milestone:** M1 | **Labels:** `jira`, `backend`

**Goal**
Turn what QA types into a deduplicated list of tickets: a single key, a pasted list, a sprint name or an epic key.

**Tasks**
- [ ] Key extraction from free text with `[A-Z]+-\d+` (commas, spaces, new lines, URLs)
- [ ] Sprint mode: `sprint = "SN - Sprint 45"` with quote escaping
- [ ] Epic mode: `parent = SHP-4084` for child tickets
- [ ] Release mode (`fixVersion = "x"`) behind a feature flag, off by default until Fix versions are confirmed in use
- [ ] Filters: issue type (Story, Bug, Task) and status
- [ ] Pagination via the Jira Cloud search endpoint (`/rest/api/3/search/jql`, token-based paging)
- [ ] Deduplicate; cap at a configurable maximum (default 100) and report if truncated
- [ ] `resolveInput({mode, value, filters})` returns `Ticket[]` plus warnings (not found, truncated)

**Acceptance criteria**
- Pasting `SHP-1, SHP-2\nSHP-3` returns three tickets.
- A sprint with more than one page of tickets returns all of them.
- Unknown keys appear as warnings and do not fail the whole request.

**Tests**
- Unit: key extraction (separators, lowercase, duplicates, junk text)
- Unit: JQL builder for every mode and filter combination, including quotes in names
- Unit: pagination across 3 fake pages; the truncation cap; warnings for missing keys

**Manual check:** resolve the real sprint `SN - Sprint 45` and epic `SHP-4084`; the counts match Jira's board.

**Dependencies:** Issue 2

---

## Issue 4: AI provider integration

**Milestone:** M2 | **Labels:** `ai`, `backend`

**Goal**
One clean interface to the AI API, so the provider can be swapped, with a fake provider for tests.

**Tasks**
- [ ] `AIProvider` interface: `generate({ system, messages, maxTokens })` returning text plus token usage
- [ ] Claude implementation (default; model id from env). Provider remains subject to company approval.
- [ ] Support prompt caching for the static system prompt block
- [ ] `FakeAIProvider` returning scripted responses for tests (success, bad JSON, error, slow)
- [ ] Provider chosen by `AI_PROVIDER` env
- [ ] Timeouts, retry with backoff for rate limits and 5xx, error mapping
- [ ] Per-run token and cost accounting; hard cap on max tokens per call
- [ ] API key only from env, never logged

**Acceptance criteria**
- One real call succeeds from a script using the real key.
- Swapping to the fake provider needs no other code change.
- Rate-limit and timeout errors are retried then surfaced as typed errors.

**Tests**
- Unit: fake provider scripting; retry and backoff (fake timers); error mapping; key redaction; usage accounting

**Manual check:** run one real call and confirm the response and token usage look right.

**Dependencies:** Issue 1. Needs an approved AI API key.

---

## Issue 5: Prompt design, output validation and eval set

**Milestone:** M2 | **Labels:** `ai`, `quality`

**Goal**
A prompt that produces structured, valid test cases and a flow, with a way to measure quality changes.

**Tasks**
- [ ] Zod schemas: `TestCase` (`id`, `ticket`, `flow_step`, `title`, `type` unit|api|ui, `priority`, `steps[]`, `expected`) and `Flow`
- [ ] Prompt builder: role, rules, output format, and ticket content inside clearly delimited data blocks, with an instruction that ticket text is data and not instructions (prompt-injection guard)
- [ ] JSON extraction and validation; retry up to 2 times, feeding the validation error back to the model
- [ ] Self-review pass: the model checks its draft against a rubric (missing negative cases, vague expected results, duplicates) and fixes it
- [ ] Eval set: about 10 real tickets with QA's own cases as reference, stored in `evals/`
- [ ] `npm run eval` script for manual or nightly runs, not part of CI

**Acceptance criteria**
- Bad JSON is retried and, after the limit, fails with a clear error.
- Invalid cases (for example a missing `expected`) are rejected.
- A ticket containing "ignore previous instructions" does not change the output format.

**Tests**
- Unit: prompt snapshots; schema accept/reject cases; retry logic with the fake provider; injection-text handling

**Manual check:** read the output for 5 real tickets and judge it against the eval references. Record the notes in `evals/NOTES.md`.

**Dependencies:** Issues 2, 4

---

## Issue 6: Generation pipeline

**Milestone:** M2 | **Labels:** `ai`, `backend`

**Goal**
Turn a list of tickets into test cases and one ordered flow, reliably, even for large sprints.

**Tasks**
- [ ] Generate cases per ticket in parallel with a concurrency limit (configurable, default 3)
- [ ] A failure on one ticket is recorded and does not abort the run
- [ ] Flow pass: one extra call that orders all cases into flow steps (selection, happy path, limits, failures, regression, or as fits the tickets)
- [ ] Every case is tagged to exactly one flow step; step order is stable
- [ ] Unique case IDs across the run (TC-1, TC-2, ...)
- [ ] Remove near-duplicate cases across tickets
- [ ] Progress callbacks (per ticket, flow step) and totals for tokens and cost

**Acceptance criteria**
- 20 tickets with 2 failures still return results for 18, plus the 2 errors.
- Every returned case has a valid flow step.
- The run completes within the configured concurrency.

**Tests**
- Unit: partial failure; concurrency limit; ID uniqueness; flow tagging; duplicate removal; progress events

**Manual check:** run a real 5-ticket batch from the command line and read the grouped result.

**Dependencies:** Issues 3, 5

---

## Issue 7: Database and run history

**Milestone:** M3 | **Labels:** `database`, `backend`

**Goal**
Persist runs, generated cases and QA's edits, so work survives restarts and the pilot can measure how much of the draft QA keeps.

**Tasks**
- [ ] Postgres with migrations; `docker-compose` for local development
- [ ] Tables: `runs`, `run_tickets`, `test_cases`, `flow_steps`, `case_revisions`
- [ ] Case state tracking: generated, edited, deleted, added by QA
- [ ] Repository layer (no SQL in services)
- [ ] Ticket-level cache keyed by ticket key + updated timestamp + prompt version, to avoid repeat AI spend
- [ ] Retention setting for old runs

**Acceptance criteria**
- Migrations run cleanly on an empty database and are repeatable.
- A run can be saved, reloaded, and edited with the history preserved.
- A query returns the "kept vs edited vs deleted" counts for a run.

**Tests**
- Unit: repository functions against in-process Postgres (PGlite), so no external database is needed in CI
- Unit: migration up/down; revision tracking; cache hit/miss rules

**Manual check:** start the compose stack, save a run, restart, and confirm it is still there.

**Dependencies:** Issue 1

---

## Issue 8: Generate API and background jobs

**Milestone:** M3 | **Labels:** `api`, `backend`

**Goal**
An HTTP API that starts a generation run in the background and reports progress, since a sprint can take minutes.

**Tasks**
- [ ] Express server setup, JSON error format, request validation (Zod)
- [ ] `POST /api/generate` (`mode`, `value`, `filters`, `useCodeContext`) returns a job id
- [ ] `GET /api/jobs/:id` returns status (queued, running, done, failed), per-ticket progress, results, errors
- [ ] `GET /api/runs` and `GET /api/runs/:id` for history
- [ ] `POST /api/jobs/:id/cancel`
- [ ] In-process job queue with a limit on simultaneous runs
- [ ] `AI_PROVIDER=fake` mode so end-to-end tests run offline

**Acceptance criteria**
- Starting a run returns immediately; polling shows progress and ends with results.
- Invalid input returns a 400 with a clear message.
- A cancelled job stops making AI calls.

**Tests**
- Unit: validation; job state transitions; cancel; concurrency limit
- Playwright (API): a full run with the fake AI and mocked Jira, from request to results

**Manual check:** call the API with a real sprint and a real AI key, and read the result.

**Dependencies:** Issues 6, 7

---

## Issue 9: Pre-prompts, knowledge base and past test cases

**Milestone:** M4 | **Labels:** `ai`, `knowledge`

**Goal**
Give the AI ShipNest knowledge before it writes, so cases match the product and the team's standards.

**Tasks**
- [ ] `knowledge/` folder (versioned in git): `overview.md`, `glossary.md`, `standards.md` (what a good test case is, coverage rules, priority definitions), `modules/*.md` (one feature map per module)
- [ ] Static system prompt assembled from overview, glossary and standards, with prompt caching
- [ ] Module selection per ticket (Jira component, labels, keywords) to include the relevant module notes
- [ ] Past approved cases: import from the confirmed source (Jira/Zephyr/Xray, sheet or doc, format to be confirmed), tagged by module
- [ ] Retrieve the top-k relevant past cases per ticket as style examples and regression hints
- [ ] Prompt version number stored with each run
- [ ] Eval comparison (from Issue 5) run before and after, with the result recorded

**Acceptance criteria**
- The system prompt includes the overview and standards in every call.
- A ticket tagged to a module gets that module's notes and relevant past cases.
- Missing knowledge files produce a warning, not a crash.

**Tests**
- Unit: knowledge loader; module selection; top-k retrieval; prompt snapshots; version stamping

**Manual check:** run the eval set before and after, and review whether the cases improved (more relevant, fewer generic ones).

**Dependencies:** Issues 5, 6. Needs the past test cases and a first draft of the feature map from QA.

---

## Issue 10: GitHub context and codebase digest

**Milestone:** M4 | **Labels:** `github`, `ai`, `backend`

**Goal**
Let the AI see what actually changed in the code for each ticket, and understand the codebase, so cases target real behavior.

**Tasks**
- [ ] `GitHubClient` using a read-only, fine-grained token from env, scoped to the ShipNest repos (configurable list)
- [ ] Find PRs by ticket key (title, branch name, description); handle multiple PRs per ticket
- [ ] Fetch the PR title, description, changed files and diff
- [ ] Filter noise (lockfiles, generated files, binaries, snapshots) and cap the size; summarize per file when too large
- [ ] Redact secrets (`.env`, keys, tokens) before anything is sent to the AI
- [ ] Codebase digest generator (`npm run digest`): reads the repo and writes per-module summaries (routes, models, validation rules, courier and store integrations) to `knowledge/codebase/`, for human review before use
- [ ] Include per-ticket PR changes and the relevant digest section in the prompt
- [ ] Per-run toggle `useCodeContext`; fall back to ticket text when no PR is found

**Acceptance criteria**
- A ticket with a known PR gets its changed files included in the prompt.
- A ticket with no PR still generates normally, with a warning.
- No secret patterns appear in anything sent to the AI.

**Tests**
- Unit: PR lookup by key; multi-PR handling; diff filtering and truncation; secret redaction on sample diffs; toggle on/off; prompt snapshot with and without code
- Unit: the digest generator's file selection and output format (the AI call uses the fake)

**Manual check:** run on a real ticket with a known PR and confirm the generated cases reference the real change. Review the digest for factual mistakes.

**Dependencies:** Issues 5, 9. Needs read access from the tech lead, and manager approval to send code to the AI provider.

---

## Issue 11: Frontend: input, progress and results

**Milestone:** M5 | **Labels:** `frontend`

**Goal**
A page where QA enters a ticket, list, sprint or epic and sees the draft cases grouped by flow step.

**Tasks**
- [ ] Vite + React + Tailwind app in `web/`
- [ ] Input form: mode selector (Ticket, List, Sprint, Epic; Release hidden until enabled), value field, filters (type, status), code-context toggle
- [ ] Progress view with per-ticket status and errors
- [ ] Results view: cases grouped by flow step, with ticket, type, priority, steps and expected result
- [ ] Run history list
- [ ] Loading, empty and error states; responsive layout
- [ ] Persistent banner: "AI draft: needs QA review"

**Acceptance criteria**
- QA can run a sprint and see progress, then grouped results.
- Errors for individual tickets are visible without hiding the others.
- The draft banner is always visible.

**Tests**
- Playwright: enter a sprint, see progress, see grouped results; list mode with a missing key warning; error state; history list

**Manual check:** use it on a real sprint and review layout and readability with a QA colleague.

**Dependencies:** Issue 8

---

## Issue 12: Edit, review and export

**Milestone:** M5 | **Labels:** `frontend`, `backend`

**Goal**
QA edits the draft, then exports it. Their edits are recorded so we can measure how much of the draft is kept.

**Tasks**
- [ ] Inline edit of title, steps, expected result, priority, type and flow step
- [ ] Add, delete and reorder cases
- [ ] Mark cases as approved
- [ ] Save edits through the API (revisions stored per Issue 7)
- [ ] Regenerate a single ticket without losing edits on others
- [ ] Export to Markdown and CSV; the "AI draft" notice is included in both
- [ ] Run summary: kept / edited / deleted / added counts

**Acceptance criteria**
- Edits survive a page reload.
- Exports contain the edited version, grouped by flow step.
- The kept/edited/deleted counts match what QA did.

**Tests**
- Unit: export formatting (Markdown, CSV escaping); summary counts
- Playwright: edit then reload; add and delete; export file contents; regenerate one ticket

**Manual check:** edit a real run, export it, and open the CSV in Excel and the Markdown in an editor.

**Dependencies:** Issues 7, 11

---

## Issue 13: Hardening, deployment and documentation

**Milestone:** M5 | **Labels:** `ops`, `security`, `docs`

**Goal**
Make it safe and repeatable to run for the team.

**Tasks**
- [ ] Structured logging (pino) with secrets and ticket bodies redacted
- [ ] Rate limiting, security headers, request size limits
- [ ] `/health` endpoint
- [ ] Access control: internal only (VPN-only or a login; decision pending)
- [ ] Dockerfile and compose for app + Postgres; non-root image
- [ ] Environment and secret handling documented (no secrets in image or repo)
- [ ] Full Playwright regression suite covering every user flow, running in CI
- [ ] README and runbook: setup, env vars, running a pilot, troubleshooting
- [ ] Usage metrics for the pilot: time per run, tokens, cost, edit rate

**Acceptance criteria**
- A clean machine can run the app from the README alone.
- Logs contain no tokens or ticket bodies.
- The full suite is green in CI.

**Tests**
- Unit: log redaction; rate limiter; auth middleware
- Playwright: full regression across input modes, results, edit and export

**Manual check:** build and run the Docker image on another machine, and run a sprint end to end.

**Dependencies:** Issues 1 to 12

---

## Issue 14: Pilot run and report (process)

**Milestone:** Pilot | **Labels:** `process`

**Goal**
Prove the tool saves time, with numbers for the manager.

**Tasks**
- [ ] Choose one real sprint or release
- [ ] QA writes cases the normal way and records the time (the 5 to 6 hour baseline)
- [ ] Run the tool on the same tickets; QA reviews and edits; record the time
- [ ] Compare: time saved, share of cases kept/edited/deleted, coverage gaps the tool missed
- [ ] Write the report with recommendations (prompt changes, knowledge gaps, next features)

**Acceptance criteria**
- A one-page report with the measured numbers and a recommendation.

**Dependencies:** Issues 1 to 13

---

## Open questions to track

1. Is sending ticket text and code to the AI provider approved? (needed by Issues 4 and 10)
2. Where do the past test cases live? (needed by Issue 9)
3. Are Fix versions used, so Release input can be enabled? (Issue 3)
4. VPN-only or a login for access? (Issue 13)
5. Jira API token or bot account, and GitHub read-only token, delivered? (Issues 2 and 10)
