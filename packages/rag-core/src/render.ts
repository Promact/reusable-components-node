import { DocumentElement, TokenCounter } from './models';

const escCell = (c: string) => c.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const csvCell = (c: string) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);

export function tableAsMarkdown(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(escCell).join(' | ')} |`;
  return [line(header), `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n');
}

export function tableAsCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

/** Compact table rendering: Markdown or CSV, whichever has fewer tokens (Markdown on a tie). */
export function renderTable(header: string[], rows: string[][], counter: TokenCounter): string {
  const md = tableAsMarkdown(header, rows);
  const csv = tableAsCsv(header, rows);
  return counter.count(csv) < counter.count(md) ? csv : md;
}

export function renderElement(el: DocumentElement, counter: TokenCounter): string {
  switch (el.kind) {
    case 'heading':
      return `${'#'.repeat(Math.min(Math.max(el.level, 1), 6))} ${el.text}`;
    case 'paragraph':
      return el.text;
    case 'list':
      return el.items.map((it, i) => (el.ordered ? `${i + 1}. ${it}` : `- ${it}`)).join('\n');
    case 'table':
      return renderTable(el.header, el.rows, counter);
    case 'code':
      return `\`\`\`${el.language ?? ''}\n${el.text}\n\`\`\``;
    case 'image':
      return el.caption ? `[Image: ${el.caption}]` : '';
  }
}

/** Canonical compact-Markdown rendering of a document (spec §6.1). */
export function renderMarkdown(elements: DocumentElement[], counter: TokenCounter): string {
  return elements
    .map((e) => renderElement(e, counter))
    .filter((s) => s.length > 0)
    .join('\n\n');
}
