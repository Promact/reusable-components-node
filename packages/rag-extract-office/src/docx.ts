import mammoth from 'mammoth';
import { XMLParser } from 'fast-xml-parser';
import { DocumentElement } from '@promact/rag-core';

type Node = Record<string, unknown>;
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, trimValues: false, parseTagValue: false });

const tagOf = (n: Node): string => Object.keys(n).find((k) => k !== ':@') as string;
const kids = (n: Node): Node[] => (n[tagOf(n)] as Node[]) ?? [];

function text(n: Node): string {
  const t = tagOf(n);
  if (t === '#text') return String(n['#text']);
  if (t === 'br') return ' ';
  return kids(n).map(text).join('');
}
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function walk(nodes: Node[], out: DocumentElement[]): void {
  for (const n of nodes) {
    const t = tagOf(n);
    if (/^h[1-6]$/.test(t)) {
      const s = clean(text(n));
      if (s) out.push({ kind: 'heading', level: Number(t[1]), text: s });
    } else if (t === 'p') {
      const s = clean(text(n));
      if (s) out.push({ kind: 'paragraph', text: s });
    } else if (t === 'ul' || t === 'ol') {
      const items = kids(n).filter((k) => tagOf(k) === 'li').map((li) => clean(text(li))).filter(Boolean);
      if (items.length) out.push({ kind: 'list', items, ordered: t === 'ol' });
    } else if (t === 'table') {
      const rows = collectRows(n).map((r) => r.map((c) => clean(text(c))));
      const [header, ...body] = rows.filter((r) => r.some(Boolean));
      if (header) out.push({ kind: 'table', header, rows: body });
    } else {
      walk(kids(n), out);
    }
  }
}

function collectRows(table: Node): Node[][] {
  const rows: Node[][] = [];
  const visit = (nodes: Node[]) => {
    for (const n of nodes) {
      if (tagOf(n) === 'tr') rows.push(kids(n).filter((c) => ['td', 'th'].includes(tagOf(c))));
      else visit(kids(n));
    }
  };
  visit(kids(table));
  return rows;
}

/** DOCX -> elements. Mammoth drops comments, revision marks and hidden content by default. */
export async function extractDocx(buf: Buffer): Promise<DocumentElement[]> {
  const { value: html } = await mammoth.convertToHtml({ buffer: buf }, { ignoreEmptyParagraphs: true });
  const elements: DocumentElement[] = [];
  walk(parser.parse(`<root>${html}</root>`) as Node[], elements);
  return elements;
}
