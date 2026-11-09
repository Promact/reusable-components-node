import { createHash } from 'crypto';
import { Chunker, ChunkingOptions, DocumentChunk, DocumentElement, ExtractedDocument, TokenCounter } from './models';
import { renderTable, tableAsMarkdown } from './render';
import { exactTokenCounter } from './tokenizer';

export interface StructureChunkerOptions {
  tokenCounter?: TokenCounter;
  /** Rows kept per table; the rest are replaced by an "N rows omitted" note. Default 1000. */
  maxTableRows?: number;
}

interface Block {
  text: string;
  page?: number;
}

type BodyElement = Exclude<DocumentElement, { kind: 'heading' }>;
type Fits = (body: string) => boolean;

const sha = (...parts: Array<string | number>): string => {
  const h = createHash('sha256');
  parts.forEach((p, i) => h.update(i === 0 ? String(p) : `\u0000${p}`));
  return h.digest('hex');
};

/** Largest k in [1, items.length] with fits(items[0..k]); returns >= 1 even if the first item alone does not fit. */
function largestFitting<T>(items: T[], fits: (group: T[]) => boolean): number {
  if (!fits(items.slice(0, 1))) return 1;
  let lo = 1; // known to fit
  let hi = 2;
  while (hi <= items.length && fits(items.slice(0, hi))) {
    lo = hi;
    hi *= 2;
  }
  hi = Math.min(hi, items.length + 1); // first size known (or assumed) not to fit
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(items.slice(0, mid))) lo = mid;
    else hi = mid;
  }
  return lo;
}

function hardSplit(word: string, fits: Fits): string[] {
  const cps = Array.from(word);
  const out: string[] = [];
  let i = 0;
  while (i < cps.length) {
    const rest = cps.slice(i);
    const n = largestFitting(rest, (g) => fits(g.join('')));
    out.push(rest.slice(0, n).join(''));
    i += n;
  }
  return out;
}

function packWords(parts: string[], sep: string, fits: Fits, splitOversize: (p: string) => string[]): string[] {
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (const p of parts) {
    if (!fits(p)) {
      flush();
      out.push(...splitOversize(p));
      continue;
    }
    const cand = cur ? cur + sep + p : p;
    if (fits(cand)) cur = cand;
    else {
      flush();
      cur = p;
    }
  }
  flush();
  return out;
}

/** Splits prose into pieces that each satisfy `fits`: sentences first, then words, then code points. */
export function splitText(text: string, fits: Fits): string[] {
  if (fits(text)) return [text];
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  return packWords(sentences, ' ', fits, (s) =>
    packWords(s.split(/\s+/).filter(Boolean), ' ', fits, (w) => hardSplit(w, fits)),
  );
}

/** Greedy grouping of lines by `fits(group)`; oversize single lines are split first by `splitLine`. */
function groupLines(lines: string[], fits: (g: string[]) => boolean, splitLine: (l: string) => string[]): string[][] {
  const expanded = lines.flatMap((l) => (fits([l]) ? [l] : splitLine(l)));
  const groups: string[][] = [];
  let i = 0;
  while (i < expanded.length) {
    const n = largestFitting(expanded.slice(i), fits);
    groups.push(expanded.slice(i, i + n));
    i += n;
  }
  return groups;
}

export function structureChunker(opts: StructureChunkerOptions = {}): Chunker {
  const counter = opts.tokenCounter ?? exactTokenCounter();
  const maxTableRows = opts.maxTableRows ?? 1000;

  function buildBlocks(el: BodyElement, fitsMax: Fits, fitsTarget: Fits): Block[] {
    const page = el.page;
    const mk = (texts: string[]): Block[] => texts.map((text) => ({ text, page }));
    const prose = (text: string): Block[] => mk(fitsMax(text) ? [text] : splitText(text, fitsTarget));

    switch (el.kind) {
      case 'paragraph':
        return prose(el.text);
      case 'image':
        return el.caption ? prose(`[Image: ${el.caption}]`) : [];
      case 'list': {
        const lines = el.items.map((it, i) => (el.ordered ? `${i + 1}. ${it}` : `- ${it}`));
        const whole = lines.join('\n');
        if (fitsMax(whole)) return mk([whole]);
        const groups = groupLines(lines, (g) => fitsTarget(g.join('\n')), (l) => splitText(l, fitsTarget));
        return mk(groups.map((g) => g.join('\n')));
      }
      case 'code': {
        const lang = el.language ?? '';
        const fence = (body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;
        const whole = fence(el.text);
        if (fitsMax(whole)) return mk([whole]);
        const groups = groupLines(
          el.text.split('\n'),
          (g) => fitsTarget(fence(g.join('\n'))),
          (l) => splitText(l, (s) => fitsTarget(fence(s))),
        );
        return mk(groups.map((g) => fence(g.join('\n'))));
      }
      case 'table': {
        const kept = el.rows.slice(0, maxTableRows);
        const omitted = el.rows.length - kept.length;
        const blocks: Block[] = [];
        const whole = renderTable(el.header, kept, counter);
        if (fitsMax(whole)) {
          blocks.push({ text: whole, page });
        } else {
          let i = 0;
          while (i < kept.length) {
            const rest = kept.slice(i);
            const n = largestFitting(rest, (g) => fitsTarget(renderTable(el.header, g, counter)));
            const group = rest.slice(0, n);
            const text = renderTable(el.header, group, counter);
            if (fitsMax(text)) blocks.push({ text, page });
            else {
              // header + one row exceeds the budget: split the bare row text instead
              blocks.push(...mk(splitText(tableAsMarkdown([], group).split('\n').slice(2).join('\n'), fitsTarget)));
            }
            i += n;
          }
        }
        if (omitted > 0) blocks.push({ text: `[${omitted} rows omitted]`, page });
        return blocks;
      }
    }
  }

  async function* chunk(doc: ExtractedDocument, options: ChunkingOptions, signal?: AbortSignal): AsyncGenerator<DocumentChunk> {
    const { targetTokens, maxTokens } = options;
    if (!Number.isInteger(targetTokens) || !Number.isInteger(maxTokens) || targetTokens < 1 || targetTokens > maxTokens) {
      throw new Error('chunking: targetTokens and maxTokens must be integers with 1 <= targetTokens <= maxTokens');
    }
    if (options.overlapTokens) {
      throw new Error('chunking: overlapTokens > 0 is not supported yet (heading-path prefix is used instead)');
    }

    const seen = new Map<string, number>();
    let ordinal = 0;
    const make = (prefix: string, body: string, headingPath: string[], pages: number[], parentChunkId: string | undefined, role: 'leaf' | 'parent'): DocumentChunk => {
      const text = prefix + body;
      const contentHash = sha(text);
      const occurrence = seen.get(contentHash) ?? 0;
      seen.set(contentHash, occurrence + 1);
      return {
        chunkId: sha(doc.documentId, contentHash, occurrence),
        documentId: doc.documentId,
        ordinal: ordinal++,
        text,
        tokenCount: counter.count(text),
        headingPath: [...headingPath],
        ...(parentChunkId ? { parentChunkId } : {}),
        ...(pages.length ? { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) } : {}),
        contentHash,
        metadata: { role },
      };
    };

    // Split into sections at headings.
    interface Section { path: string[]; elements: BodyElement[] }
    const sections: Section[] = [];
    const stack: Array<{ level: number; text: string }> = [];
    let current: Section = { path: [], elements: [] };
    sections.push(current);
    for (const el of doc.elements) {
      if (el.kind === 'heading') {
        while (stack.length && stack[stack.length - 1].level >= el.level) stack.pop();
        stack.push({ level: el.level, text: el.text });
        current = { path: stack.map((s) => s.text), elements: [] };
        sections.push(current);
      } else {
        current.elements.push(el);
      }
    }

    for (const section of sections) {
      signal?.throwIfAborted();
      if (section.elements.length === 0) continue;

      let prefix = section.path.length ? `${section.path.join(' > ')}\n\n` : '';
      if (prefix && counter.count(prefix) > targetTokens / 2) prefix = ''; // too large to be useful; path stays in metadata
      const fitsMax: Fits = (b) => counter.count(prefix + b) <= maxTokens;
      const fitsTarget: Fits = (b) => counter.count(prefix + b) <= targetTokens;

      const blocks = section.elements.flatMap((el) => buildBlocks(el, fitsMax, fitsTarget));

      // Pack blocks into leaf bodies up to targetTokens (an atomic block above target goes alone, up to max).
      const leaves: Array<{ body: string; pages: number[] }> = [];
      let cur: { body: string; pages: number[] } | undefined;
      for (const b of blocks) {
        const pages = b.page !== undefined ? [b.page] : [];
        if (cur) {
          const cand = `${cur.body}\n\n${b.text}`;
          if (fitsTarget(cand)) {
            cur = { body: cand, pages: [...cur.pages, ...pages] };
            continue;
          }
          leaves.push(cur);
        }
        cur = { body: b.text, pages };
      }
      if (cur) leaves.push(cur);

      // Parents: consecutive leaves whose combined text still fits maxTokens (small-to-big).
      let i = 0;
      while (i < leaves.length) {
        const rest = leaves.slice(i);
        const n = largestFitting(rest, (g) => fitsMax(g.map((l) => l.body).join('\n\n')));
        const group = rest.slice(0, n);
        i += n;
        let parentId: string | undefined;
        if (group.length > 1) {
          const parent = make(prefix, group.map((l) => l.body).join('\n\n'), section.path, group.flatMap((l) => l.pages), undefined, 'parent');
          parentId = parent.chunkId;
          yield parent;
        }
        for (const l of group) yield make(prefix, l.body, section.path, l.pages, parentId, 'leaf');
      }
    }
  }

  return { chunk };
}
