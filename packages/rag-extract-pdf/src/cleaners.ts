import { ContentCleaner, DocumentElement, ExtractedDocument } from '@promact/rag-core';

// Only paragraphs and headings are ever removed by the cleaners in this file.
const elementChars = (e: DocumentElement): number => (e.kind === 'paragraph' || e.kind === 'heading' ? e.text.length : 0);

/** Same bookkeeping as rag-core's cleaners: appends a step to `doc.cleaning`. */
function withStep(doc: ExtractedDocument, cleaner: string, removed: DocumentElement[]): ExtractedDocument {
  const drop = new Set(removed);
  const charsRemoved = removed.reduce((n, e) => n + elementChars(e), 0);
  const prev = doc.cleaning ?? { charsRemoved: 0, elementsRemoved: 0, steps: [] };
  return {
    ...doc,
    elements: doc.elements.filter((e) => !drop.has(e)),
    cleaning: {
      charsRemoved: prev.charsRemoved + charsRemoved,
      elementsRemoved: prev.elementsRemoved + removed.length,
      steps: [...prev.steps, { cleaner, charsRemoved, elementsRemoved: removed.length }],
    },
  };
}

const EDGE = 2;

export interface ArtifactCleanerOptions {
  /** A line must repeat on at least this many distinct pages (default 3). */
  minPages?: number;
  /** ...and on at least this fraction of all pages (default 0.5). */
  minFraction?: number;
}

/** Page-number-insensitive key: "Page 3 of 10" and "Page 4 of 10" collide. */
const artifactKey = (text: string): string => text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/**
 * Removes running headers, footers and page numbers: single-line paragraphs/headings that repeat (ignoring digits)
 * on many pages. Anything with a `page` and a single line of text is a candidate, so body paragraphs that merely
 * repeat on two pages are kept.
 */
export function pdfArtifactCleaner(options: ArtifactCleanerOptions = {}): ContentCleaner {
  const minPages = options.minPages ?? 3;
  const minFraction = options.minFraction ?? 0.5;
  return {
    async clean(doc) {
      const pagesOf = new Map<string, Set<number>>();
      const candidates: Array<{ el: DocumentElement; key: string }> = [];
      // Only the first/last two elements of a page can be running headers/footers; "Step 1" in the middle of a page is content.
      const onPage = new Map<number, DocumentElement[]>();
      for (const el of doc.elements) if (el.page !== undefined) onPage.set(el.page, [...(onPage.get(el.page) ?? []), el]);
      const atEdge = (el: DocumentElement): boolean => {
        const els = onPage.get(el.page as number) as DocumentElement[];
        const i = els.indexOf(el);
        return i < EDGE || i >= els.length - EDGE;
      };
      for (const el of doc.elements) {
        if ((el.kind !== 'paragraph' && el.kind !== 'heading') || el.page === undefined || el.text.includes('\n') || !atEdge(el)) continue;
        const key = artifactKey(el.text);
        if (!key) continue;
        candidates.push({ el, key });
        const set = pagesOf.get(key) ?? new Set<number>();
        set.add(el.page);
        pagesOf.set(key, set);
      }
      const total = doc.stats.pages ?? new Set(doc.elements.map((e) => e.page)).size;
      const removed = candidates
        .filter(({ key }) => {
          const n = (pagesOf.get(key) as Set<number>).size;
          return n >= minPages && n >= total * minFraction;
        })
        .map((c) => c.el);
      return withStep(doc, 'pdfArtifactCleaner', removed);
    },
  };
}

const LEADER_LINE = /^.{2,}?(?:\.{3,}|(?:\.\s){3,}|…{2,}|_{3,})\s*(?:\d{1,4}|[ivxlc]{1,6})\s*$/i;
const TOC_HEADING = /^(?:table of contents|contents|index)$/i;

/** Removes table-of-contents blocks (dot-leader lines ending in a page number) and a directly preceding "Contents" heading. */
export function pdfTocCleaner(): ContentCleaner {
  return {
    async clean(doc) {
      const removed: DocumentElement[] = [];
      doc.elements.forEach((el, i) => {
        if (el.kind !== 'paragraph') return;
        const lines = el.text.split('\n');
        if (lines.length < 2 || lines.filter((l) => LEADER_LINE.test(l.trim())).length < lines.length * 0.8) return;
        removed.push(el);
        const before = doc.elements[i - 1];
        if (before?.kind === 'heading' && TOC_HEADING.test(before.text.trim())) removed.push(before);
      });
      return withStep(doc, 'pdfTocCleaner', removed);
    },
  };
}
