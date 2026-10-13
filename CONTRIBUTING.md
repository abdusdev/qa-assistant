# Contributing

How work is done in this repository. The same rules apply to everyone, including the author.

## The workflow

1. **Start from an issue.** Every change has a GitHub issue (goal, what we will do, done when, tests,
   manual check, dependencies) and a matching Jira story under epic SHP-4110. The issue has a milestone
   and a label.
2. **Branch from `main`.** Name it `SHP-<jira number>-<short-name>`, for example
   `SHP-4120-github-context`. Do not build on top of another unmerged branch. If a change depends on an
   open pull request, wait for it to merge.
3. **Write the code and its tests together.** Unit tests (Vitest) for logic, Playwright for a flow a
   user can see. A test must be able to fail: break the code on purpose and check that a test notices.
4. **Run `npm run check` before opening the pull request.** It runs exactly what CI runs: lint, format,
   types, unit tests with the coverage threshold, and the end-to-end tests.
5. **Open a pull request into `main`** using the template. Put `Closes #<issue>` in the description
   before it is merged, say what you checked, and say what is not done.
6. **Get a review.** Another person reads it before it is merged. CI must be green.
7. **After the merge,** the issue closes and the Jira story moves to Done.

## Rules that are not negotiable

- **No secrets** in code, tests, logs, commit messages or pull requests. Settings come from environment
  variables (see `.env.example`). `.env` is never committed.
- **No real ticket text or real source code** in tests, examples or evals. Use fictional wording. Real
  ticket text and company code may only go to an AI provider the company has approved. The free Gemini
  tier may use content it receives to improve its products, so it is not approved for real data by
  default (see `ALLOW_CODE_TO_AI` in `.env.example`).
- **The tool writes drafts.** Its output is never final and it never generates test code.
- **Say what you did not check.** A pull request that lists its limits is better than one that hides
  them.

## Useful commands

| Command                                                             | What it does                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `npm run check`                                                     | Everything CI runs                                              |
| `npm test`                                                          | Unit tests                                                      |
| `npm run test:coverage`                                             | Unit tests with the 80% threshold                               |
| `npm run pipeline -- file evals/tickets/example-bulk-shipment.json` | Run the pipeline on an example ticket                           |
| `npm run github -- context SHP-1234`                                | Show the code text that would be sent for a ticket (no AI call) |

See the README for setup and the architecture note in `docs/architecture.md` for how a run flows.

## Commit messages

Start with a short imperative sentence ("Add database: run history..."). Explain the why in the body when
it is not obvious. One idea per commit where that is practical.
