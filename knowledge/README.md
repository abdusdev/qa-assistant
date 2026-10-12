# Knowledge folder

What the AI is told about ShipNest **before** it writes test cases. The better these files are, the
less the AI has to guess. Everything here is plain Markdown, reviewed in pull requests like code.

```
knowledge/
├── overview.md         what ShipNest is and how it is used          (sent with every ticket)
├── glossary.md         the product's own words                      (sent with every ticket)
├── standards.md        what a good test case is for this team       (sent with every ticket)
├── modules/            one note per module                          (only the matching one is sent)
│   └── shipments.md
└── past-cases/         approved cases, as examples                  (the most similar few are sent)
    └── shipments.md
```

Files that start with `_` and this README are ignored, so the templates never reach the AI. A file
that is still only the template counts as "not filled in" and is skipped with a warning.

## Who writes what

| File                         | Best written by                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `overview.md`, `glossary.md` | Someone who knows the product (QA lead, product owner)                            |
| `standards.md`               | QA, from how cases are written today. A sensible default is included              |
| `modules/*.md`               | The person who knows that module best. Real button names and messages matter most |
| `past-cases/*.md`            | QA: export approved cases (see below)                                             |

## Module notes

Start from `modules/_template.md`. The header tells the tool which tickets the note is for:

```
---
name: Shipments
components: [Shipments]          # Jira components that belong to this module
labels: [shipments, rates]       # Jira labels
keywords: [rates, label, tracking]   # words in the ticket summary or description
---
```

A ticket gets a note when its component or label matches, or its summary contains a keyword. See
what a ticket would get with `npm run knowledge -- match SHP-1234`, and the components and labels
that exist with `npm run knowledge -- components`.

Put in the note what a tester must know and a ticket will not say: **the exact names of screens,
buttons, fields and messages**, the limits and rules, and the usual failure behaviour. Keep each note
under about 3,000 characters. The AI quotes these names, and the tool checks that a quoted name
really comes from the ticket or from here.

## Past cases

Use `past-cases/_template.md`, or import a CSV export (a sheet, Zephyr, Xray...):

```bash
npm run knowledge -- import-cases approved-cases.csv --module Shipments
```

Columns are matched by name (`Title`, `Steps`, `Expected Result`, `Component`, `Priority`, `Type`...).
Rows without a title or an expected result are skipped and listed. Read the result before using it.

Choose cases you would be happy to see copied: current, specific, correct. Ten good ones beat a
hundred old ones.

## Checking it

```bash
npm run knowledge -- check          # what was found, what is missing, how long it is
```

## Do not put here

Secrets, customer names or personal data, internal URLs with tokens. These files are sent to the AI
provider with the tickets.
