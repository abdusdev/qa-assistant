<!-- A sensible default. Edit it to match how your team writes cases. -->

## What a good case looks like

- One purpose per case. If the title needs "and", it is two cases.
- The title says what is being checked and under which condition ("Shipping is blocked when the
  address changed and rates were not refetched").
- Steps are short, concrete actions in order. Someone who has never used the screen can follow them.
- The expected result is one clear, checkable statement. Give exact values, counts and messages when
  they are known. "Works correctly" is never an expected result.
- State the setup and test data a case needs (number of orders, user role, existing records).

## Coverage to consider for every feature

- Happy path: the normal journey works.
- Boundaries: just below, at and just above every limit, and empty, one and many.
- Validation: missing, wrong, duplicate and over-long input.
- Failures: the courier or store is unavailable, a request is rejected, only part of a batch succeeds.
- Permissions: a user without the right role cannot do it and cannot see it.
- State: things that were done before (an old rate, an edited address, a voided shipment).
- Regression: related behaviour that this change could break.

## Priority

- High: money, shipping correctness, data safety, or a core flow is blocked.
- Medium: normal functionality that has a workaround.
- Low: cosmetic, rare, or easily recovered.

## Wording

- Use the product's own names for screens, buttons, fields and messages, exactly as they appear.
- Do not invent a name. If the exact text is not known, describe it ("a validation error about the
  missing name") and say it needs confirming.

## Flow

Order cases so that setup comes before what uses it, then happy path, boundaries, failures and
regression last. A case that needs something another case creates comes after that case.
