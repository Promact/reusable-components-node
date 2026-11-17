import { DocumentElement, ExtractedDocument } from '@promact/rag-core';
import { pdfArtifactCleaner, pdfTocCleaner } from './cleaners';

const doc = (elements: DocumentElement[], pages?: number): ExtractedDocument => ({
  documentId: 'd',
  contentHash: 'h',
  elements,
  stats: { rawChars: 0, rawTokens: 0, pages, elementsDropped: 0, pagesNeedingOcr: [] },
});
const p = (text: string, page?: number): DocumentElement => ({ kind: 'paragraph', text, page });

describe('pdfArtifactCleaner', () => {
  it('removes headers, footers and page numbers that repeat across pages, and records stats', async () => {
    const els: DocumentElement[] = [];
    for (let n = 1; n <= 4; n++) els.push(p('ACME Confidential', n), p(`Unique body ${'x'.repeat(n)}`, n), p(`Page ${n} of 4`, n), { kind: 'heading', level: 1, text: String(n), page: n });
    const out = await pdfArtifactCleaner().clean(doc(els, 4));
    expect(out.elements.map((e) => (e.kind === 'paragraph' ? e.text : ''))).toEqual([1, 2, 3, 4].map((n) => `Unique body ${'x'.repeat(n)}`));
    expect(out.cleaning).toMatchObject({ elementsRemoved: 12, steps: [{ cleaner: 'pdfArtifactCleaner', elementsRemoved: 12 }] });
    expect(out.cleaning?.charsRemoved).toBe(4 * ('ACME Confidential'.length + 'Page 1 of 4'.length + 1));
  });

  it('keeps text that repeats on too few pages or fraction, multi-line text, empties and page-less elements', async () => {
    const els: DocumentElement[] = [p('Repeated twice', 1), p('Repeated twice', 2), p('a\nb', 1), p('a\nb', 2), p('a\nb', 3), p('...', 1), p('x', undefined), p('x', undefined), p('x', undefined)];
    const out = await pdfArtifactCleaner({ minPages: 2, minFraction: 1 }).clean(doc(els, 10));
    expect(out.elements).toHaveLength(els.length);
    expect(out.cleaning?.elementsRemoved).toBe(0);
    const out2 = await pdfArtifactCleaner({ minPages: 2, minFraction: 0.1 }).clean(doc(els, 10));
    expect(out2.elements.filter((e) => e.kind === 'paragraph' && e.text === 'Repeated twice')).toHaveLength(0);
  });

  it('keeps digit-only-different lines in the middle of pages', async () => {
    const els = [1, 2, 3].flatMap((n) => [p('Top', n), p('Intro a', n), p('Intro b', n), p(`Step ${n}`, n), p('More a', n), p('More b', n), p('Bottom', n)]);
    const out = await pdfArtifactCleaner().clean(doc(els, 3));
    expect(out.elements.filter((e) => e.kind === 'paragraph' && e.text.startsWith('Step'))).toHaveLength(3);
    expect(out.elements.some((e) => e.kind === 'paragraph' && e.text === 'Top')).toBe(false);
  });

  it('falls back to counting pages from elements when stats.pages is missing', async () => {
    const els = [1, 2, 3].flatMap((n) => [p('Header', n), p(`body ${'x'.repeat(n)}`, n)]);
    const out = await pdfArtifactCleaner().clean(doc(els));
    expect(out.elements).toHaveLength(3);
  });

  it('accumulates onto earlier cleaning stats', async () => {
    const prior = { ...doc([p('x', 1)]), cleaning: { charsRemoved: 5, elementsRemoved: 1, steps: [{ cleaner: 'other', charsRemoved: 5, elementsRemoved: 1 }] } };
    const out = await pdfArtifactCleaner().clean(prior);
    expect(out.cleaning?.steps.map((s) => s.cleaner)).toEqual(['other', 'pdfArtifactCleaner']);
    expect(out.cleaning?.charsRemoved).toBe(5);
  });
});

describe('pdfTocCleaner', () => {
  it('removes dot-leader TOC blocks and the Contents heading before them', async () => {
    const toc = p(['Introduction ........ 3', 'Architecture . . . . . 4', 'Appendix …… iv'].join('\n'), 1);
    const out = await pdfTocCleaner().clean(doc([{ kind: 'heading', level: 1, text: 'Table of Contents', page: 1 }, toc, p('Real content paragraph.', 2)]));
    expect(out.elements).toEqual([p('Real content paragraph.', 2)]);
    expect(out.cleaning?.steps[0]).toMatchObject({ cleaner: 'pdfTocCleaner', elementsRemoved: 2 });
  });

  it('keeps a TOC without a heading match, single lines, mostly-prose blocks, and non-paragraphs', async () => {
    const toc = p('One ..... 1\nTwo ..... 2', 1);
    const prose = p('A sentence ..... 5\nplain text here\nmore plain text', 1);
    const out = await pdfTocCleaner().clean(
      doc([{ kind: 'heading', level: 1, text: 'Overview', page: 1 }, toc, p('Single ..... 9', 1), prose, { kind: 'list', items: ['a'], ordered: false }]),
    );
    expect(out.elements).toHaveLength(4);
    expect(out.elements.find((e) => e === toc)).toBeUndefined();
    expect(out.elements).toContain(prose);
  });

  it('handles a TOC that is the first element', async () => {
    const out = await pdfTocCleaner().clean(doc([p('One ..... 1\nTwo ..... 2', 1)]));
    expect(out.elements).toEqual([]);
  });
});
