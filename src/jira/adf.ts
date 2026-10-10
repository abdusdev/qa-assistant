/**
 * Converts Atlassian Document Format (ADF), the JSON Jira Cloud uses for rich text,
 * into plain text that is readable by people and by the AI.
 *
 * Unknown node types never throw: they fall back to the text of their children.
 */

export interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

const ATTACHMENT = '[attachment]';

function attrString(node: AdfNode, key: string): string | undefined {
  const value = node.attrs?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function renderText(node: AdfNode): string {
  const text = node.text ?? '';
  const link = node.marks?.find((mark) => mark.type === 'link');
  const href = link?.attrs?.href;
  if (typeof href === 'string' && href !== '' && href !== text) {
    return `${text} (${href})`;
  }
  return text;
}

function renderDate(node: AdfNode): string {
  const raw = node.attrs?.timestamp;
  const millis = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (Number.isNaN(millis)) return '';
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function renderInline(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return renderText(node);
    case 'hardBreak':
      return '\n';
    case 'mention':
      return attrString(node, 'text') ?? '@user';
    case 'emoji':
      return attrString(node, 'text') ?? attrString(node, 'shortName') ?? '';
    case 'status':
      return `[${attrString(node, 'text') ?? ''}]`;
    case 'date':
      return renderDate(node);
    case 'inlineCard':
      return attrString(node, 'url') ?? '';
    case 'media':
    case 'mediaInline':
      return ATTACHMENT;
    default:
      return renderChildrenInline(node);
  }
}

function renderChildrenInline(node: AdfNode): string {
  return (node.content ?? []).map(renderInline).join('');
}

function renderBlocks(nodes: AdfNode[] | undefined): string {
  return (nodes ?? [])
    .map(renderBlock)
    .filter((text) => text !== '')
    .join('\n\n');
}

function renderListItem(item: AdfNode, marker: string): string {
  const body = (item.content ?? []).map(renderBlock).join('\n');
  const [first = '', ...rest] = body.split('\n');
  const pad = ' '.repeat(marker.length + 1);
  return [`${marker} ${first}`, ...rest.map((line) => (line === '' ? line : pad + line))].join(
    '\n',
  );
}

function renderList(node: AdfNode): string {
  const ordered = node.type === 'orderedList';
  const start = typeof node.attrs?.order === 'number' ? node.attrs.order : 1;
  return (node.content ?? [])
    .map((item, index) => renderListItem(item, ordered ? `${start + index}.` : '-'))
    .join('\n');
}

function renderTaskList(node: AdfNode): string {
  return (node.content ?? [])
    .map((task) => {
      const done = task.attrs?.state === 'DONE';
      return `- [${done ? 'x' : ' '}] ${renderChildrenInline(task)}`;
    })
    .join('\n');
}

function renderCell(cell: AdfNode): string {
  return renderBlocks(cell.content)
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

function renderTable(node: AdfNode): string {
  const lines: string[] = [];
  (node.content ?? []).forEach((row, index) => {
    const cells = row.content ?? [];
    lines.push(`| ${cells.map(renderCell).join(' | ')} |`);
    const isHeader =
      index === 0 && cells.length > 0 && cells.every((c) => c.type === 'tableHeader');
    if (isHeader) lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
  });
  return lines.join('\n');
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
      return renderChildrenInline(node);
    case 'heading': {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${renderChildrenInline(node)}`;
    }
    case 'bulletList':
    case 'orderedList':
      return renderList(node);
    case 'taskList':
    case 'decisionList':
      return renderTaskList(node);
    case 'blockquote':
      return renderBlocks(node.content).replace(/^/gm, '> ');
    case 'codeBlock': {
      const language = attrString(node, 'language') ?? '';
      return `\`\`\`${language}\n${renderChildrenInline(node)}\n\`\`\``;
    }
    case 'rule':
      return '---';
    case 'table':
      return renderTable(node);
    case 'panel': {
      const kind = attrString(node, 'panelType');
      const label = kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}: ` : '';
      return label + renderBlocks(node.content);
    }
    case 'expand':
    case 'nestedExpand': {
      const title = attrString(node, 'title');
      return (title ? `${title}:\n` : '') + renderBlocks(node.content);
    }
    case 'mediaSingle':
    case 'mediaGroup':
      return ATTACHMENT;
    case 'text':
    case 'hardBreak':
    case 'mention':
    case 'emoji':
    case 'status':
    case 'date':
    case 'inlineCard':
    case 'media':
    case 'mediaInline':
      return renderInline(node);
    default:
      // Unknown node: keep any text it holds, block children separated by blank lines.
      return node.content?.some((child) => child.type === 'text')
        ? renderChildrenInline(node)
        : renderBlocks(node.content);
  }
}

/** Converts an ADF document (or an already-plain string, or nothing) into plain text. */
export function adfToText(adf: unknown): string {
  if (adf === null || adf === undefined) return '';
  if (typeof adf === 'string') return adf.trim();
  if (typeof adf !== 'object') return '';

  const node = adf as AdfNode;
  const text = node.type === 'doc' ? renderBlocks(node.content) : renderBlock(node);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
