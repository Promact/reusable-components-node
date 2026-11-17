import { readFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';
import { getEventListeners } from 'events';
import { DocumentSource } from '@promact/rag-core';
import { createPdfExtractor, DEFAULT_LIMITS, pdfArtifactCleaner, pdfTocCleaner, PdfExtractionError } from './index';

jest.mock('pdfjs-dist/legacy/build/pdf.js', () => {
  const actual = jest.requireActual('pdfjs-dist/legacy/build/pdf.js');
  return { ...actual, getDocument: jest.fn(actual.getDocument) };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js') as { getDocument: jest.Mock };

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', name));
const src = (content: DocumentSource['content'], over: Partial<DocumentSource> = {}): DocumentSource => ({
  documentId: 'doc',
  content,
  contentType: 'application/pdf',
  documentVersion: 1,
  tenantId: 't',
  aclGroups: ['g'],
  ...over,
});
const extract = (name: string, options = {}) => createPdfExtractor(options).extract(src(fixture(name)), {});
const rejection = async (p: Promise<unknown>): Promise<PdfExtractionError> => {
  try {
    await p;
  } catch (e) {
    return e as PdfExtractionError;
  }
  throw new Error('expected rejection');
};
const hang = () => ({ promise: new Promise(() => undefined), destroy: jest.fn(async () => undefined) });

describe('canExtract / config', () => {
  const ex = createPdfExtractor();
  it('recognises PDFs by content type or by file name for generic types', () => {
    expect(ex.canExtract('application/pdf; charset=binary')).toBe(true);
    expect(ex.canExtract('application/octet-stream', 'A.PDF')).toBe(true);
    expect(ex.canExtract('', 'a.pdf')).toBe(true);
    expect(ex.canExtract('', undefined)).toBe(false);
    expect(ex.canExtract('text/plain', 'a.pdf')).toBe(false);
  });
  it('validates options eagerly', () => {
    expect(() => createPdfExtractor({ limits: { maxPages: 0 } })).toThrow(/maxPages/);
    expect(() => createPdfExtractor({ limits: { timeoutMs: NaN } })).toThrow(/timeoutMs/);
    expect(() => createPdfExtractor({ minCharsPerPage: -1 })).toThrow(/minCharsPerPage/);
    expect(DEFAULT_LIMITS.maxFileBytes).toBeGreaterThan(0);
  });
  it('rejects other content types', async () => {
    expect((await rejection(createPdfExtractor().extract(src(Buffer.from('x'), { contentType: 'text/plain' }), {}))).code).toBe('UNSUPPORTED_TYPE');
  });
});

describe('extraction of fixtures', () => {
  it('extracts single-column text with headings and paragraphs on page 1', async () => {
    const d = await extract('single-column.pdf');
    expect(d.documentId).toBe('doc');
    expect(d.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.elements[0]).toEqual({ kind: 'heading', level: 1, text: 'Engineering Handbook', page: 1 });
    expect(d.elements[2]).toEqual({ kind: 'heading', level: 2, text: 'Tooling', page: 1 });
    expect(d.elements.every((e) => e.page === 1)).toBe(true);
    expect(d.stats).toMatchObject({ pages: 1, pagesNeedingOcr: [], elementsDropped: 0 });
    expect(d.stats.rawTokens).toBeGreaterThan(0);
  });

  it('keeps the two columns apart', async () => {
    const d = await extract('two-column.pdf');
    expect(d.elements).toHaveLength(2);
    expect(JSON.stringify(d.elements[0])).toContain('apples');
    expect(JSON.stringify(d.elements[0])).not.toContain('boats');
    expect(JSON.stringify(d.elements[1])).toContain('planes');
  });

  it('detects the table', async () => {
    const d = await extract('table.pdf');
    expect(d.elements.find((e) => e.kind === 'table')).toEqual({
      kind: 'table',
      header: ['Item', 'Quantity', 'Price'],
      rows: [['Widget', '10', '4.50'], ['Gadget', '25', '12.00'], ['Gizmo', '3', '99.99']],
      page: 1,
    });
  });

  it('cleans repeated header/footer and the TOC with the exported cleaners', async () => {
    let d = await extract('header-footer.pdf');
    expect(d.elements).toHaveLength(12);
    d = await pdfArtifactCleaner().clean(d);
    expect(d.elements.map((e) => (e.kind === 'paragraph' ? e.page : -1))).toEqual([1, 2, 3, 4]);
    expect(JSON.stringify(d.elements)).not.toMatch(/Acme|Page \d/);

    let toc = await extract('toc.pdf');
    toc = await pdfTocCleaner().clean(toc);
    expect(toc.elements).toEqual([
      { kind: 'heading', level: 1, text: 'Introduction', page: 2 },
      { kind: 'paragraph', text: 'This guide introduces the product and its goals in plain words.', page: 2 },
    ]);
  });

  it('flags image-only pages for OCR', async () => {
    const d = await extract('scanned.pdf');
    expect(d.stats.pagesNeedingOcr).toEqual([2]);
    expect(d.stats.pages).toBe(2);
    expect(d.elements.every((e) => e.page === 1)).toBe(true);
  });

  it('accepts a stream and a custom token counter', async () => {
    const count = jest.fn(() => 7);
    const d = await createPdfExtractor().extract(src(Readable.from([fixture('table.pdf')])), { tokenCounter: { count, isExact: true } as never });
    expect(d.stats.rawTokens).toBe(7);
    const s = await createPdfExtractor().extract(src(Readable.from(['%PDF-not really'])), {}).catch((e) => e);
    expect(s).toBeInstanceOf(PdfExtractionError);
  });
});

describe('limits and failures', () => {
  it('rejects oversized buffers and streams', async () => {
    const small = { limits: { maxFileBytes: 100 } };
    expect((await rejection(extract('table.pdf', small))).code).toBe('FILE_TOO_LARGE');
    const destroy = jest.fn();
    const stream = Object.assign(Readable.from([Buffer.alloc(80), Buffer.alloc(80)]), { destroy });
    expect((await rejection(createPdfExtractor(small).extract(src(stream), {}))).code).toBe('FILE_TOO_LARGE');
    expect(destroy).toHaveBeenCalled();
  });

  it('rejects PDFs with too many pages', async () => {
    expect((await rejection(extract('header-footer.pdf', { limits: { maxPages: 3 } }))).code).toBe('TOO_MANY_PAGES');
  });

  it('rejects garbage and encrypted files with typed errors', async () => {
    const bad = await rejection(createPdfExtractor().extract(src(Buffer.from('this is not a pdf')), {}));
    expect(bad.code).toBe('INVALID_PDF');
    pdfjs.getDocument.mockImplementationOnce(() => ({ promise: Promise.reject({ name: 'PasswordException' }), destroy: jest.fn(async () => undefined) }));
    expect((await rejection(extract('table.pdf'))).code).toBe('ENCRYPTED');
    pdfjs.getDocument.mockImplementationOnce(() => ({ promise: Promise.reject(undefined), destroy: jest.fn(async () => undefined) }));
    expect((await rejection(extract('table.pdf'))).message).toMatch(/unknown error/);
  });

  it('honours an already-aborted signal and an abort during parsing', async () => {
    const pre = new AbortController();
    pre.abort();
    expect((await rejection(createPdfExtractor().extract(src(fixture('table.pdf')), {}, pre.signal))).code).toBe('ABORTED');

    const ctl = new AbortController();
    const h = hang();
    pdfjs.getDocument.mockImplementationOnce(() => h);
    const p = createPdfExtractor().extract(src(fixture('table.pdf')), {}, ctl.signal);
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    expect((await rejection(p)).code).toBe('ABORTED');
    expect(h.destroy).toHaveBeenCalled();
  });

  it('opens PDFs with eval disabled (CVE-2024-4367 mitigation for pdfjs-dist 3.x) and no font/network loading', async () => {
    await extract('table.pdf');
    expect(pdfjs.getDocument).toHaveBeenLastCalledWith(expect.objectContaining({ isEvalSupported: false, disableFontFace: true, useSystemFonts: false }));
    expect(pdfjs.getDocument.mock.lastCall[0]).not.toHaveProperty('url');
  });

  it('removes its abort listener from the caller\'s signal after each extraction', async () => {
    const ctl = new AbortController();
    for (let i = 0; i < 3; i++) await createPdfExtractor().extract(src(fixture('table.pdf')), {}, ctl.signal);
    await rejection(createPdfExtractor().extract(src(Buffer.from('not a pdf')), {}, ctl.signal));
    expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
  });

  it('times out a stuck parser and destroys the pdf.js task', async () => {
    const h = hang();
    pdfjs.getDocument.mockImplementationOnce(() => h);
    expect((await rejection(extract('table.pdf', { limits: { timeoutMs: 30 } }))).code).toBe('TIMEOUT');
    expect(h.destroy).toHaveBeenCalled();
  });

  it('stops between pages when aborted mid-extraction', async () => {
    const ctl = new AbortController();
    const page = { view: [0, 0, 612, 792], getTextContent: async () => ({ items: [{ type: 'beginMarkedContent' }, { str: 'hello there friend, how are you today', transform: [11, 0, 0, 11, 72, 700], width: 200 }] }), cleanup: jest.fn() };
    pdfjs.getDocument.mockImplementationOnce(() => ({
      promise: Promise.resolve({ numPages: 3, getPage: async () => { ctl.abort(); return page; } }),
      destroy: async () => undefined,
    }));
    expect((await rejection(createPdfExtractor().extract(src(fixture('table.pdf')), {}, ctl.signal))).code).toBe('ABORTED');
  });

  it('skips marked-content items', async () => {
    const page = { view: [0, 0, 612, 792], getTextContent: async () => ({ items: [{ type: 'beginMarkedContent' }, { str: 'hello there friend, how are you today', transform: [11, 0, 0, 11, 72, 700], width: 200 }] }), cleanup: jest.fn() };
    pdfjs.getDocument.mockImplementationOnce(() => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page }), destroy: async () => undefined }));
    const d = await extract('table.pdf');
    expect(d.elements).toEqual([{ kind: 'paragraph', text: 'hello there friend, how are you today', page: 1 }]);
  });
});
