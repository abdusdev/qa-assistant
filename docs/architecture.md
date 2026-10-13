# Architecture

How one run turns Jira tickets into draft test cases and a test flow. Everything is a draft for QA to
review: the tool never produces test code and never treats its own output as final.

## The flow of a run

```
 input (ticket, list, sprint, epic)
        │
        ▼
 src/jira ─────────── resolve the input to tickets, convert rich text to plain text
        │
        ▼  for each ticket, up to N at the same time
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ context                                                                  │
 │   src/knowledge   product overview, glossary, standards, the matching     │
 │                   module note, a few similar approved past cases          │
 │   src/github      the ticket's pull requests: description and the most    │
 │                   relevant changed lines, with secrets replaced           │
 │                                                                          │
 │ result cache      unchanged ticket + same context + same prompt → reuse   │
 │                                                                          │
 │ src/ai            one prompt: ticket + context → plan of behaviours and   │
 │                   cases (JSON), validated; optional self-review pass       │
 │   grounding       every case's sources are checked against the text it    │
 │                   was given; invented labels, codes and numbers are       │
 │                   listed as "to confirm"                                  │
 └──────────────────────────────────────────────────────────────────────────┘
        │
        ▼
 src/pipeline ─────── join the cases of all tickets, remove cross-ticket
                      duplicates, number them, order them into one flow
        │
        ▼
 src/db ───────────── save the run, tickets, flow, cases and QA edits
        │
        ▼
 output: cases + flow + warnings (what was missing, what is assumed)
```

## Modules

| Folder          | Responsibility                                                                        |
| --------------- | ------------------------------------------------------------------------------------- |
| `src/config`    | Reads and validates settings from environment variables                               |
| `src/jira`      | Jira client, rich text conversion, ticket keys, search queries, input resolving       |
| `src/ai`        | Provider interface (Gemini, fake), prompts, JSON validation, grounding, flow ordering |
| `src/knowledge` | Loads the `knowledge/` folder, matches notes and past cases to a ticket               |
| `src/github`    | Read-only GitHub client, pull request lookup, code summary, secret redaction, digest  |
| `src/pipeline`  | Runs many tickets: concurrency, partial failure, duplicates, flow, cache              |
| `src/db`        | Postgres (or in-process PGlite): migrations, repository, result cache                 |
| `src/server`    | HTTP server (health check today; the generate API is issue #8)                        |
| `src/util`      | Small helpers (concurrency limit, text similarity)                                    |

## Decisions worth knowing

- **One AI provider interface.** Gemini is used now; a model that runs out of its daily quota falls back
  to the next configured model. Swapping the provider does not touch the pipeline.
- **The model's claims are checked, not trusted.** A case that cites a source is accepted only if the
  quote is really in the text the model was given.
- **Failures are isolated.** One ticket failing never stops the others, and a run that hits a rate limit
  keeps what finished.
- **Nothing sensitive leaves without agreement.** Real tickets and source code need explicit settings
  before they go to an AI provider (see `SECURITY.md`).
- **Requests, not tokens, are the limit on the free tier.** The plan step therefore runs inside the same
  AI call rather than as a separate one.
- **Everything runs from the command line today.** `npm run pipeline` calls the same code the API will
  call, so the API (issue #8) is a thin layer over the pipeline.
