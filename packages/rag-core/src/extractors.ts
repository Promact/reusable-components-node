import { createHash } from 'crypto';
import { DocumentElement, DocumentExtractor, DocumentSource, ExtractedDocument, ExtractionOptions } from './models';
import { exactTokenCounter } from './tokenizer';
import fromMarkdownModule from 'mdast-util-from-markdown';
import gfmSyntaxModule from 'micromark-extension-gfm';
import * as gfmMdastModule from 'mdast-util-gfm';

const fromMarkdown = fromMarkdownModule as unknown as (src: string, opts?: unknown) => MdNode;
const gfmSyntax = gfmSyntaxModule as unknown as () => unknown;
const gfmMdast = (gfmMdastModule as unknown as { fromMarkdown: unknown }).fromMarkdown;

interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  lang?: string | null;
  alt?: string | null;
  children?: MdNode[];
}

async function readAll(content: DocumentSource['content']): Promise<Buffer> {
  if (Buffer.isBuffer(content)) return content;
  const chunks: Buffer[] = [];
  for await (const c of content as AsyncIterable<Buffer | string>) {
    chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  }
  return Buffer.concat(chunks);
}

function finish(source: DocumentSource, raw: Buffer, text: string, elements: DocumentElement[], dropped: number, options: ExtractionOptions): ExtractedDocument {
  const counter = options.tokenCounter ?? exactTokenCounter();
  return {
    documentId: source.documentId,
    contentHash: createHash('sha256').update(raw).digest('hex'),
    elements,
    stats: { rawChars: text.length, rawTokens: counter.count(text), elementsDropped: dropped, pagesNeedingOcr: [] },
  };
}

const ext = (fileName?: string) => (fileName ?? '').toLowerCase().split('.').pop() ?? '';
const baseType = (ct: string) => ct.split(';')[0].trim().toLowerCase();

export function txtExtractor(): DocumentExtractor {
  return {
    canExtract: (ct, fileName) => baseType(ct) === 'text/plain' || (baseType(ct) === '' && ext(fileName) === 'txt'),
    async extract(source, options) {
      const raw = await readAll(source.content);
      const text = raw.toString('utf8').replace(/^\uFEFF/, '');
      const elements: DocumentElement[] = text
        .split(/\r?\n[ \t]*\r?\n/)
        .map((p) => p.replace(/\r?\n/g, ' ').trim())
        .filter(Boolean)
        .map((p) => ({ kind: 'paragraph' as const, text: p }));
      return finish(source, raw, text, elements, 0, options);
    },
  };
}

function inlineText(n: MdNode): string {
  if (n.type === 'break') return ' ';
  if (n.type === 'image') return n.alt ?? '';
  if (typeof n.value === 'string') return n.value;
  return (n.children ?? []).map(inlineText).join('');
}

function convert(nodes: MdNode[], out: DocumentElement[], stats: { dropped: number }): void {
  for (const n of nodes) {
    switch (n.type) {
      case 'heading':
        out.push({ kind: 'heading', level: n.depth ?? 1, text: inlineText(n).trim() });
        break;
      case 'paragraph': {
        const kids = n.children ?? [];
        if (kids.length === 1 && kids[0].type === 'image') {
          const caption = kids[0].alt?.trim();
          if (caption) out.push({ kind: 'image', caption });
          else stats.dropped++;
        } else {
          const text = inlineText(n).trim();
          if (text) out.push({ kind: 'paragraph', text });
        }
        break;
      }
      case 'list':
        out.push({
          kind: 'list',
          ordered: !!n.ordered,
          items: (n.children ?? []).map((li) => (li.children ?? []).map(inlineText).join(' ').trim()),
        });
        break;
      case 'code':
        out.push({ kind: 'code', text: n.value ?? '', ...(n.lang ? { language: n.lang } : {}) });
        break;
      case 'table': {
        const rows = (n.children ?? []).map((r) => (r.children ?? []).map((c) => inlineText(c).trim()));
        out.push({ kind: 'table', header: rows[0] ?? [], rows: rows.slice(1) });
        break;
      }
      case 'blockquote':
        convert(n.children ?? [], out, stats);
        break;
      default: // html, thematicBreak, definitions … carry no content
        stats.dropped++;
    }
  }
}

export function markdownExtractor(): DocumentExtractor {
  return {
    canExtract: (ct, fileName) => {
      const t = baseType(ct);
      return t === 'text/markdown' || t === 'text/x-markdown' || ((t === '' || t === 'text/plain') && ['md', 'markdown'].includes(ext(fileName)));
    },
    async extract(source, options) {
      const raw = await readAll(source.content);
      const text = raw.toString('utf8').replace(/^\uFEFF/, '');
      const tree = fromMarkdown(text, { extensions: [gfmSyntax()], mdastExtensions: [gfmMdast] });
      const elements: DocumentElement[] = [];
      const stats = { dropped: 0 };
      convert(tree.children ?? [], elements, stats);
      return finish(source, raw, text, elements, stats.dropped, options);
    },
  };
}

