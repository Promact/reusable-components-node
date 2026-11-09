import { ContentCleaner, DocumentElement, ExtractedDocument } from './models';

/**
 * Zero-width, bidi-control and "tag" characters. They are invisible to a human reviewer but are
 * seen by the model (hidden prompt-injection payloads) and split words so keyword/embedding
 * matching degrades. Includes ZWNJ/ZWJ (U+200C/D): this over-strips for Persian/Indic shaping
 * and emoji sequences; accepted trade-off for a security-first default (spec §8.2).
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5],
  [0x180b, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164],
  [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0xe0000, 0xe0fff],
];

const isInvisible = (cp: number): boolean => INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

export function stripInvisible(text: string): string {
  let out = '';
  for (const ch of text) {
    if (!isInvisible(ch.codePointAt(0) as number)) out += ch;
  }
  return out;
}

/** NFKC + invisible-char removal + de-hyphenation + whitespace collapse (prose only). */
export function normalizeProse(text: string): string {
  let t = stripInvisible(text).normalize('NFKC');
  t = stripInvisible(t); // NFKC can expose compatibility forms of invisible characters
  t = t.replace(/([A-Za-zÀ-ɏ])-[ \t]*\r?\n[ \t]*([a-zß-ÿ])/g, '$1$2'); // "exam-\nple"
  return t.replace(/\s+/g, ' ').trim();
}

const textLen = (els: DocumentElement[]): number =>
  els.reduce((n, e) => {
    switch (e.kind) {
      case 'heading':
      case 'paragraph':
      case 'code':
        return n + e.text.length;
      case 'list':
        return n + e.items.reduce((a, i) => a + i.length, 0);
      case 'table':
        return n + [e.header, ...e.rows].reduce((a, r) => a + r.reduce((b, c) => b + c.length, 0), 0);
      case 'image':
        return n + (e.caption?.length ?? 0);
    }
  }, 0);

function withStep(doc: ExtractedDocument, cleaner: string, elements: DocumentElement[]): ExtractedDocument {
  const charsRemoved = Math.max(0, textLen(doc.elements) - textLen(elements));
  const elementsRemoved = doc.elements.length - elements.length;
  const prev = doc.cleaning ?? { charsRemoved: 0, elementsRemoved: 0, steps: [] };
  return {
    ...doc,
    elements,
    cleaning: {
      charsRemoved: prev.charsRemoved + charsRemoved,
      elementsRemoved: prev.elementsRemoved + elementsRemoved,
      steps: [...prev.steps, { cleaner, charsRemoved, elementsRemoved }],
    },
  };
}

function cleanElement(el: DocumentElement): DocumentElement | undefined {
  switch (el.kind) {
    case 'heading':
    case 'paragraph': {
      const text = normalizeProse(el.text);
      return text ? { ...el, text } : undefined;
    }
    case 'code': {
      const text = stripInvisible(el.text);
      return text.trim() ? { ...el, text } : undefined;
    }
    case 'list': {
      const items = el.items.map(normalizeProse).filter(Boolean);
      return items.length ? { ...el, items } : undefined;
    }
    case 'table': {
      const header = el.header.map(normalizeProse);
      const rows = el.rows.map((r) => r.map(normalizeProse)).filter((r) => r.some(Boolean));
      return header.some(Boolean) || rows.length ? { ...el, header, rows } : undefined;
    }
    case 'image': {
      const caption = el.caption ? normalizeProse(el.caption) : '';
      return caption ? { ...el, caption } : undefined;
    }
  }
}

export function whitespaceUnicodeCleaner(): ContentCleaner {
  return {
    async clean(doc) {
      const elements = doc.elements.map(cleanElement).filter((e): e is DocumentElement => e !== undefined);
      return withStep(doc, 'whitespaceUnicodeCleaner', elements);
    },
  };
}

/** Removes exact duplicate paragraphs (first occurrence wins). `minChars` spares short ones like "N/A". */
export function duplicateBlockCleaner(options: { minChars?: number } = {}): ContentCleaner {
  const minChars = options.minChars ?? 0;
  return {
    async clean(doc) {
      const seen = new Set<string>();
      const elements = doc.elements.filter((e) => {
        if (e.kind !== 'paragraph' || e.text.length < minChars) return true;
        if (seen.has(e.text)) return false;
        seen.add(e.text);
        return true;
      });
      return withStep(doc, 'duplicateBlockCleaner', elements);
    },
  };
}

/** Runs cleaners in order; each step's removals are accumulated in `doc.cleaning`. */
export function cleanerChain(cleaners: ContentCleaner[]): ContentCleaner {
  return {
    async clean(doc, signal) {
      let current = doc;
      for (const c of cleaners) {
        signal?.throwIfAborted();
        current = await c.clean(current, signal);
      }
      return current;
    },
  };
}
