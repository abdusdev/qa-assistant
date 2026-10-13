# Security

## What must never be committed

- API keys, tokens and passwords (Jira, GitHub, AI provider), or the `.env` file
- Real Jira ticket text, real comments, or real ShipNest source code
- Output files from a real run (`out/` is ignored for this reason)

If something sensitive is committed by mistake, tell the maintainer straight away. The secret must be
revoked and replaced, because removing it from a later commit does not remove it from the history.

## What the tool does to protect data

- Settings are read from environment variables, and a configuration error names the setting, never
  its value.
- Anything that looks like a secret (tokens, keys, passwords, credentials in URLs) is replaced before
  pull request text or code is used, and files such as `.env`, keys and certificates are never read.
- Sending source code to the AI provider needs an explicit setting (`ALLOW_CODE_TO_AI=true`) or flag.
  Without it the run stops.
- Real tickets need `--allow-real-tickets` for the same reason: the free Gemini tier may use what it
  receives to improve its products.

## Reporting a problem

Tell the repository maintainer directly (do not open a public issue with details). Include what you
saw and how to reproduce it, but not the secret itself.
