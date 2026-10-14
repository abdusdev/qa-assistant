# Pilot protocol

How to measure, with real numbers, whether QA Assistant saves time. It takes one sprint or release of tickets
and about half a day of QA time on top of normal work. The result is one page that says adopt, adopt with
changes, or not yet.

The tool writes a **draft**. Everything below measures how much of that draft QA kept and how much time that
saved. It does not measure whether the final cases are good: QA's review is what makes them good.

## Before you start

| Check                                                                                      | Why                                                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| The tool runs on a machine the team can open (see [runbook](runbook.md))                   | The reviewers use the page                                                                   |
| A paid AI key, or written approval to send real tickets on the free tier                   | The free tier may use what it receives, and its daily limit stops a real sprint (runbook §5) |
| Product notes and past cases are in `knowledge/` for the area being tested                 | Without them the draft is generic; this is the single biggest effect on the result           |
| The tickets are chosen: **one real sprint or release, at least 8 tickets**                 | Fewer than that is an anecdote                                                               |
| Code context decided: on (needs `GITHUB_TOKEN`, `GITHUB_REPOS`, `ALLOW_CODE_TO_AI`) or off | Keep it the same for the whole pilot, or the numbers cannot be compared                      |
| One or two reviewers named, and told this is a measurement, not a performance review       | People change how they work when they think they are being judged                            |

## Step 1: write the cases the normal way (the baseline)

Do this **first, without looking at the tool's draft**. If QA sees the draft before writing their own, the
manual time is no longer a fair baseline.

For each ticket, the person who would normally write the cases:

1. Starts a timer when they open the ticket.
2. Writes the cases the way they always do, in their usual place.
3. Stops the timer when the cases are done and ready to hand over.
4. Writes the minutes in the baseline file (below).

Time only the work on that ticket. If they are interrupted, pause the timer.

Make the baseline file with `npm run pilot -- template --out baseline.csv`, or copy
[pilot/baseline-template.csv](pilot/baseline-template.csv):

```csv
ticket,manual_minutes,review_minutes,missed_cases,notes
SHP-4107,75,,,
SHP-4108,40,,,
```

## Step 2: run the tool on the same tickets

1. Open the page, choose **list** and paste the same tickets, or choose the sprint or epic.
2. Note the time the run started. The report reads it from the database; you do not need to write it down.
3. When it finishes, check the warnings on each ticket. A ticket that failed is reported as failed, not
   hidden. Run it again; the report uses the latest run of each ticket.

Do not tune the prompt, the knowledge or the settings between runs during the pilot. If you must, write down
what changed and when.

## Step 3: review and edit the draft

For each ticket, the same person who wrote the baseline:

1. Starts a timer when they open the draft.
2. Reads every case. Edits what is wrong, deletes what is not useful, adds what is missing, and approves what
   they would be happy to hand over.
3. Stops the timer when the cases are ready to hand over, **to the same standard as the baseline**.
4. Writes the minutes in `review_minutes`, and the number of cases they had to write because the tool missed
   them in `missed_cases`.

Use their own name in the sign-in so changes are recorded under it.

Reading and approving counts as review time. A draft that is quick to approve but not read is not a result.

## Step 4: build the report

```bash
npm run pilot -- report --since 2026-10-14 --baseline baseline.csv --out pilot-report.md --title "Sprint 42 pilot"
```

`--since` and `--until` choose runs by date. `--runs id,id` chooses them by id (`npm run db -- runs` lists them).

The report counts, from the database: cases kept, edited, deleted and added; how long the tool took; tokens and
cost; and what QA changed. It adds QA's recorded minutes for the time comparison. Then it gives a suggested
reading using fixed thresholds that it prints, so the team can argue with them.

## Step 5: write the last section by hand

The report ends with five lines only people can write:

- what the tool did well
- what it got wrong or missed that the numbers do not show
- the prompt or knowledge changes to make first
- the next feature, if any
- the decision and who owns it

Use the report's own signals: the **most edited field** points at the prompt; the **tickets did not give**
list points at missing knowledge or tickets that need better description; the **QA added** list shows what
kinds of cases the tool does not think of.

## How to read the numbers

| Number              | Good sign                    | Warning                                                                              |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| Cases that survived | 60% or more                  | Under 40% means QA rewrites most of it; fix knowledge or prompt before using it      |
| Time saved          | 30% or more                  | Under 10% is not worth the change; negative means reviewing took longer than writing |
| Cases QA had to add | Small share of the final set | A large share means the tool misses whole kinds of scenarios                         |
| Deleted             | A few                        | Many means noise: duplicates, unrelated cases, or tickets with too little detail     |
| Cost                | Cents per ticket             | Compare with the minutes saved: one hour of QA costs far more than the tokens        |

## Limits to say out loud

- **Small sample.** Eight to fifteen tickets from one sprint show a direction, not a precise percentage.
- **One or two reviewers.** Their speed and habits are in the number. A second reviewer on a few tickets shows
  how much.
- **Learning effect.** The first review of a draft is slower than the tenth. If the pilot is repeated, the
  time saved will probably rise.
- **Manual time is self-reported.** It is only as honest as the timer. That is why the baseline is written
  before the draft is seen.
- **Kept is not correct.** A case that was approved unchanged may still be wrong. The tool cannot see that;
  only a later bug that slipped through can.

## Done

The pilot is done when `pilot-report.md` has numbers for at least 8 tickets, the five hand-written lines are
filled in, and the team has written the decision and its owner. Keep the report with the sprint notes.
