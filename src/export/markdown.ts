import {
  AI_DRAFT_NOTICE,
  GROUNDING_LABEL,
  REVIEW_STATUS,
  SOURCE_LABEL,
  groupByFlow,
  summarize,
  type ExportCase,
  type ExportRun,
  type ExportTicket,
} from './model.js';

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function caseBlock(c: ExportCase): string[] {
  const lines = [
    `### ${c.id}: ${oneLine(c.title)}`,
    '',
    `**${c.type.toUpperCase()}** | **${c.priority}** priority | ${c.ticket} | ${REVIEW_STATUS[c.state]}`,
    '',
  ];

  if (c.preconditions.length > 0) {
    lines.push('**Preconditions**', '', ...c.preconditions.map((p) => `- ${oneLine(p)}`), '');
  }
  lines.push('**Steps**', '', ...c.steps.map((step, i) => `${i + 1}. ${oneLine(step)}`), '');
  lines.push(`**Expected result:** ${oneLine(c.expected)}`, '');

  if (c.dependsOn.length > 0) lines.push(`**Runs after:** ${c.dependsOn.join(', ')}`, '');

  const sources = c.sources.filter((s) => s.from !== 'inferred' || s.quote !== '');
  lines.push(`**Based on:** ${GROUNDING_LABEL[c.grounding]}`);
  for (const source of sources) {
    lines.push(
      `- ${SOURCE_LABEL[source.from]}${source.quote ? `: "${oneLine(source.quote)}"` : ''}`,
    );
  }
  if (c.assumptions.length > 0) {
    lines.push('', '**To confirm**', '', ...c.assumptions.map((a) => `- ${oneLine(a)}`));
  }
  lines.push('');
  return lines;
}

const quote = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');

/** The tickets the cases were written against, with their full text, before any case. */
function ticketSection(tickets: ExportTicket[]): string[] {
  if (tickets.length === 0) return [];
  const lines: string[] = [
    '## Tickets covered',
    '',
    `The cases below were written against ${tickets.length === 1 ? 'this ticket' : 'these tickets'}, in this wording.`,
    '',
  ];
  for (const { key, snapshot } of tickets) {
    if (!snapshot) {
      lines.push(`### ${key}`, '', '_The ticket text was not saved with this run._', '');
      continue;
    }
    lines.push(`### ${key}: ${oneLine(snapshot.summary)}`, '');
    lines.push(
      [
        `Type: ${snapshot.type}`,
        `Status: ${snapshot.status}`,
        snapshot.labels.length > 0 && `Labels: ${snapshot.labels.join(', ')}`,
        snapshot.parentKey && `Parent: ${snapshot.parentKey}`,
        snapshot.url,
      ]
        .filter(Boolean)
        .join(' | '),
      '',
    );
    lines.push('**Description**', '', quote(snapshot.description.trim() || '(empty)'), '');
    if (snapshot.acceptanceCriteria?.trim()) {
      lines.push('**Acceptance criteria**', '', quote(snapshot.acceptanceCriteria), '');
    }
    if (snapshot.comments.length > 0) {
      lines.push(`**Comments (${snapshot.commentCount})**`, '');
      for (const comment of snapshot.comments) {
        lines.push(
          quote(`${comment.author}, ${comment.created.slice(0, 10)}: ${comment.body}`),
          '',
        );
      }
    }
    if (snapshot.truncated) {
      lines.push('_Some of this ticket was shortened because it was very long._', '');
    }
  }
  return lines;
}

/** The run as a Markdown document: notice, the tickets, summary, then the cases by flow step. */
export function toMarkdown(run: ExportRun): string {
  const groups = groupByFlow(run);
  const summary = summarize(run.cases);
  const lines: string[] = [`# ${oneLine(run.title)}`, '', `> **${AI_DRAFT_NOTICE}**`, ''];

  const facts = [
    `Source: ${run.source}`,
    run.generatedAt && `Generated: ${run.generatedAt.toISOString().slice(0, 10)}`,
    run.model && `Model: ${run.model}`,
    run.author && `Author: ${run.author}`,
  ].filter((part): part is string => Boolean(part));
  lines.push(facts.join(' | '), '');

  lines.push(...ticketSection(run.tickets));

  lines.push('## Summary', '');
  lines.push(`- Cases: ${summary.total}`);
  if (summary.generated > 0 || summary.added > 0) {
    lines.push(
      `- AI cases kept: ${summary.kept}, edited: ${summary.edited}, deleted: ${summary.deleted}; added by QA: ${summary.added}`,
    );
  }
  lines.push(`- Flow steps: ${groups.length}`, '');

  if (run.plan.length > 0) {
    lines.push('## What the cases cover', '');
    lines.push('| Ticket | Behaviour | Covered by |', '| --- | --- | --- |');
    for (const item of run.plan) {
      const by = item.coveredBy.length > 0 ? item.coveredBy.join(', ') : '**not covered**';
      lines.push(`| ${item.ticket} | ${oneLine(item.behaviour).replace(/\|/g, '\\|')} | ${by} |`);
    }
    lines.push('');
  }

  for (const group of groups) {
    lines.push(`## ${group.step.order}. ${oneLine(group.step.name)}`, '');
    if (group.step.description) lines.push(oneLine(group.step.description), '');
    for (const c of group.cases) lines.push(...caseBlock(c));
  }

  if (run.warnings.length > 0) {
    lines.push('## Notes', '', ...run.warnings.map((w) => `- ${oneLine(w)}`), '');
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
