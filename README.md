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

| Command                 | What it does                                          |
| ----------------------- | ----------------------------------------------------- |
| `npm run dev`           | Start the server with auto-reload                     |
| `npm start`             | Start the server                                      |
| `npm test`              | Run unit tests (Vitest)                               |
| `npm run test:coverage` | Run unit tests with the 80% coverage threshold        |
| `npm run test:e2e`      | Run end-to-end tests (Playwright)                     |
| `npm run lint`          | Lint the code                                         |
| `npm run format`        | Format the code (`format:check` only checks)          |
| `npm run typecheck`     | Type-check the code                                   |
| `npm run check`         | Everything CI runs: lint, format, types, unit and e2e |

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
| `tests/e2e/`   | Playwright tests                          |
| `docs/`        | Project plan and notes                    |

## Workflow

1. Pick the next GitHub issue and its Jira ticket.
2. Branch from `main`, named after the Jira key: `SHP-4111-short-name`.
3. Build the change with its tests, then run `npm run check`.
4. Open a pull request with `Closes #N` in the description. CI must pass to merge.
