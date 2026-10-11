# Evaluation set

A small set of tickets with QA's own test cases, used to judge the prompt. Run by hand:

```bash
npm run eval              # every ticket in evals/tickets
npm run eval -- bulk      # only files whose name contains "bulk"
```

It needs `AI_PROVIDER=gemini` (with `AI_API_KEY` and `AI_MODEL`) in `.env`. It never runs in CI, because it calls
the real AI, takes time and costs tokens.

## What it prints

For each ticket: how many cases came back, how many attempts it took, whether the self-review pass
produced the final cases, the tokens used, how many of QA's reference cases have a similar generated
case, and the list of generated cases.

The "matches N of M reference cases" number is a **rough guide** (word overlap). Always read the cases
and decide yourself. Write what you see in `NOTES.md`.

## Adding a ticket

Create `evals/tickets/<name>.json`:

```json
{
  "ticket": {
    "key": "SHP-1234",
    "summary": "...",
    "type": "Story",
    "status": "Done",
    "description": "...",
    "acceptanceCriteria": "..."
  },
  "reference": [{ "title": "How QA would name the case", "expected": "What QA expects to see" }]
}
```

- Use **real tickets and QA's real cases** for the pilot, about 10 of them.
- Real ticket text must not go through a free-tier AI key (Google may use free-tier content to improve its
  products). Use the paid tier, or get your manager's approval first.
- `example-bulk-shipment.json` is made up and safe to use anywhere.
