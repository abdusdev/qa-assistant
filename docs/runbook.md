# Runbook

How to run QA Assistant for a team, and what to do when something is wrong. For what the tool does, see
the [README](../README.md). For how a run flows, see [architecture](architecture.md).

## 1. Run it from a clean machine

You need Node.js 22 or newer (or Docker), and the settings below. Nothing else.

**With Node**

```bash
git clone https://github.com/abdusdev/qa-assistant.git
cd qa-assistant
npm ci
cp .env.example .env      # then fill in the values you need (section 2)
npm run build:web         # builds the page
npm start                 # http://localhost:3000
```

**With Docker** (the page, the API and a Postgres database)

```bash
cp .env.example .env      # fill in the values you need
docker compose --profile app up -d --build
```

Open `http://localhost:3000`. The database address is set by the compose file, so `DATABASE_URL` in `.env` is
ignored there. Set `POSTGRES_PASSWORD` in `.env` before anyone else can reach the machine.

Check it is up: `GET /health` answers `{"status":"ok"}` and `GET /ready` answers `{"status":"ready"}` once the
database answers.

## 2. Settings

Settings are environment variables (see `.env.example`). A wrong or missing setting stops the server at start
with a message that names the setting, never its value. **No secret is in the image or the repository.**

| Setting                                              | Needed for                             | Notes                                                                          |
| ---------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`      | Reading tickets                        | A read-only account is best. Without them a run fails with a clear message.    |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`              | Writing cases                          | `fake` is an offline demo that gives predictable, useless cases.               |
| `AI_FALLBACK_MODELS`                                 | Surviving a daily quota                | Comma-separated, tried in order.                                               |
| `GITHUB_TOKEN`, `GITHUB_REPOS`                       | Code context                           | A read-only token for the listed repositories.                                 |
| `ALLOW_CODE_TO_AI`                                   | Sending source code to the AI provider | Off by default. Turn on only with approval (see section 5).                    |
| `DATABASE_URL`                                       | History, review, cached results        | Empty keeps a database in `.data/`. `postgres://...` uses a server.            |
| `API_TOKEN`                                          | Access control                         | At least 8 characters. When set, everything under `/api` needs it (section 4). |
| `PORT`, `LOG_LEVEL`                                  | Basics                                 | Log level is `debug`, `info`, `warn` or `error`.                               |
| `MAX_CONCURRENT_RUNS`                                | Parallel runs                          | Default 1. Each run still shares the AI provider's quota.                      |
| `RATE_LIMIT_PER_MINUTE`, `GENERATE_LIMIT_PER_MINUTE` | Abuse and cost protection              | Per client: requests to `/api` (default 300) and runs started (default 20).    |
| `TRUST_PROXY`                                        | Running behind a proxy                 | Turn on so limits count real clients, not the proxy.                           |
| `ENABLE_HSTS`                                        | Running behind HTTPS                   | Tells browsers to use HTTPS only. Do not turn on for plain HTTP.               |
| `DB_RETENTION_DAYS`                                  | Housekeeping                           | Used by `npm run db -- purge` (default 90).                                    |

## 3. Logs

The server writes one JSON line per event to standard output (`docker logs`, or your log collector).

- Every request is one line: method, path, status and time. **No query values, no bodies, no headers.**
- Anything logged is scrubbed first: token-shaped text is replaced, and values named like a credential or like
  ticket text (description, comments, steps, expected, prompt, code changes) are removed. A ticket is identified
  by its key only.
- `level` is 30 info, 40 warn, 50 error. A run that failed unexpectedly is logged with its job id; the person who
  started it only sees "The run failed unexpectedly. See the server log."

## 4. Who can use it

The server has one shared access token. Choose one of these, and say which in your team notes:

1. **Network only.** Run it where only the team can reach it (VPN, internal network) and leave `API_TOKEN` empty.
   Simple, but anyone on that network can use it, and changes are recorded only under the name `qa`.
2. **Token.** Set `API_TOKEN`. The page asks for it once per browser tab, with a name that is recorded on every
   change. Give the token to the team through your password manager, and change it when someone leaves.

Do both for anything reachable beyond the team. A token over plain HTTP can be read on the network, so use HTTPS
(a proxy in front, with `TRUST_PROXY` and `ENABLE_HSTS` on).

This is shared-secret access, not individual accounts. If you need to know exactly who did what, that is the next
step (a login provider), not a setting.

## 5. Data that leaves the machine

Running a ticket sends its text to the AI provider. Sending code (`ALLOW_CODE_TO_AI`) also sends pull request
changes. On a **free** Gemini tier, Google may use what it receives to improve its products and reviewers may
read it. Use the paid tier, or get the company's approval, before using real tickets or code in daily work.

Secrets are never sent: tokens and keys in text are replaced first, and `.env` files, keys and certificates are
never read.

## 6. Backups and upgrades

- **Back up** the database: `pg_dump -U qa qa_assistant > backup.sql` (with Docker:
  `docker compose exec postgres pg_dump -U qa qa_assistant > backup.sql`). The `knowledge/` folder is in git.
- **Restore:** `psql -U qa qa_assistant < backup.sql` into an empty database.
- **Upgrade:** pull, `npm ci`, `npm run build:web`, restart. With Docker: `docker compose --profile app up -d
--build`. Database changes are applied on start (`npm run db -- status` shows them).
- **Housekeeping:** `npm run db -- purge` removes runs and cached results older than `DB_RETENTION_DAYS`.

## 7. When something is wrong

| What you see                                   | Why                                                                       | What to do                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| "Waiting in the queue" for minutes             | Another run holds the only slot, often waiting out an AI error            | Cancel the other run on the page, or raise `MAX_CONCURRENT_RUNS`.         |
| Runs fail with 503 "high demand"               | The AI provider is overloaded (common on the free tier)                   | Try again later, or use a paid key.                                       |
| Runs fail with 429 or "daily limit"            | The model's daily request quota is used up                                | Set `AI_FALLBACK_MODELS`, wait for the reset, or use a paid key.          |
| "No tickets matched" or "not found (404)"      | The key is wrong, was moved or deleted, or the Jira account cannot see it | Check it in Jira. `npm run jira:check` tests the connection.              |
| Code context is skipped with a warning         | `GITHUB_TOKEN` or `GITHUB_REPOS` is not set                               | Set them, or leave code context off.                                      |
| "sending code has not been approved"           | `ALLOW_CODE_TO_AI` is off                                                 | Decide (section 5). Untick code context for one run, or set the setting.  |
| 429 from the API                               | A client went over the limits                                             | Wait the number of seconds in `Retry-After`, or raise the limits.         |
| 401 from the API, or the page asks for a token | `API_TOKEN` is set and was missing or wrong                               | Sign in with the right token.                                             |
| `/ready` answers 503                           | The database does not answer                                              | Check Postgres is up and `DATABASE_URL` is right. `npm run db -- status`. |
| The server will not start                      | A setting is missing or invalid                                           | Read the first line of the output: it names the setting.                  |
| The page says "The web interface is not built" | `web/dist` does not exist                                                 | Run `npm run build:web` (Docker builds it).                               |

## 8. Before you let others use it

- [ ] `API_TOKEN` set, or the server is reachable only by the team
- [ ] HTTPS in front of it if it is not on a private network, with `TRUST_PROXY` and `ENABLE_HSTS` on
- [ ] A paid AI key, or written approval to use the free tier for real tickets
- [ ] `ALLOW_CODE_TO_AI` decided on purpose
- [ ] `POSTGRES_PASSWORD` changed from the default
- [ ] A backup of the database arranged
- [ ] The Jira account is read-only
