import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { DocumentSource } from '@promact/rag-core';
import { createOfficeExtractor, OfficeExtractionError, OfficeErrorCode } from './index';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const fx = (n: string) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', n));

const src = (content: DocumentSource['content'], contentType: string, fileName?: string): DocumentSource => ({
  documentId: 'd1', content, contentType, fileName, documentVersion: 1, tenantId: 't', aclGroups: ['g'],
});

async function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
  const z = new JSZip();
  for (const [k, v] of Object.entries(files)) z.file(k, v);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function code(p: Promise<unknown>): Promise<OfficeErrorCode> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OfficeExtractionError);
    return (e as OfficeExtractionError).code;
  }
  throw new Error('expected rejection');
}

describe('canExtract', () => {
  const x = createOfficeExtractor();
  it('matches by content type, ignoring parameters', () => {
    expect(x.canExtract(DOCX)).toBe(true);
    expect(x.canExtract(`${XLSX}; charset=binary`)).toBe(true);
    expect(x.canExtract(PPTX)).toBe(true);
    expect(x.canExtract('application/pdf')).toBe(false);
  });
  it('falls back to the extension for generic or empty types', () => {
    expect(x.canExtract('application/octet-stream', 'A.DOCX')).toBe(true);
    expect(x.canExtract('', 'a.xlsx')).toBe(true);
    expect(x.canExtract('', 'a.txt')).toBe(false);
    expect(x.canExtract('')).toBe(false);
  });
});

describe('DOCX', () => {
  it('extracts headings, paragraphs, lists and tables', async () => {
    const doc = await createOfficeExtractor().extract(src(fx('sample.docx'), DOCX), {});
    expect(doc.elements).toEqual([
      { kind: 'heading', level: 1, text: 'Fixture Handbook' },
      { kind: 'paragraph', text: 'This paragraph describes the onboarding process for new engineers.' },
      { kind: 'heading', level: 2, text: 'Setup' },
      { kind: 'list', items: ['Install Node', 'Clone the repository'], ordered: false },
      { kind: 'table', header: ['Tool', 'Purpose'], rows: [['npm', 'packages'], ['jest', 'tests']] },
      { kind: 'paragraph', text: 'Closing remarks end the document.' },
    ]);
    expect(doc.documentId).toBe('d1');
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.stats.rawChars).toBeGreaterThan(50);
    expect(doc.stats.rawTokens).toBeGreaterThan(10);
  });

  it('accepts a stream and uses a custom token counter', async () => {
    const counter = { count: () => 7, countMany: () => [7] } as never;
    const doc = await createOfficeExtractor().extract(src(Readable.from([fx('sample.docx')]), '', 'x.docx'), { tokenCounter: counter });
    expect(doc.stats.rawTokens).toBe(7);
  });

  it('handles ordered lists, empty tables, empty items, soft breaks and nested html', async () => {
    const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const body =
      '<w:p><w:r><w:t>One</w:t><w:br/><w:t>two</w:t></w:r></w:p><w:p><w:r><w:t> </w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>' +
      '<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>H</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>v</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t></w:t></w:r></w:p>';
    const buf = await zipOf({
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': `<w:document ${w}><w:body>${body}</w:body></w:document>`,
    });
    const doc = await createOfficeExtractor().extract(src(buf, DOCX), {});
    expect(doc.elements).toEqual([{ kind: 'paragraph', text: 'One two' }, { kind: 'table', header: ['H'], rows: [['v']] }]);
  });
});

describe('XLSX', () => {
  it('emits one heading + table per visible non-empty sheet', async () => {
    const doc = await createOfficeExtractor().extract(src(fx('sample.xlsx'), XLSX), {});
    expect(doc.elements).toEqual([
      { kind: 'heading', level: 1, text: 'Inventory' },
      { kind: 'table', header: ['Item', 'Qty', 'Price'], rows: [['Widget', '10', '2.5'], ['Gadget', '3', '9']] },
      { kind: 'heading', level: 1, text: 'Notes' },
      { kind: 'table', header: ['Owner', 'Comment'], rows: [['Asha', 'Reorder gadgets in March']] },
    ]);
    expect(doc.stats.elementsDropped).toBe(2); // empty + hidden sheets
  });
});

describe('PPTX', () => {
  it('emits one section per slide in numeric order; notes are opt-in', async () => {
    const doc = await createOfficeExtractor().extract(src(fx('sample.pptx'), PPTX), {});
    expect(doc.elements).toEqual([
      { kind: 'heading', level: 1, text: 'Quarterly Review', page: 1 },
      { kind: 'paragraph', text: 'Prepared by the platform team', page: 1 },
      { kind: 'heading', level: 1, text: 'Slide 2', page: 2 },
      { kind: 'paragraph', text: 'Untitled slide body', page: 2 },
      { kind: 'heading', level: 1, text: 'Wrap Up', page: 10 },
      { kind: 'paragraph', text: 'Questions welcome', page: 10 },
    ]);
    expect(doc.stats.pages).toBe(3);
  });

  it('includes speaker notes when asked', async () => {
    const doc = await createOfficeExtractor({ includeSpeakerNotes: true }).extract(src(fx('sample.pptx'), PPTX), {});
    expect(doc.elements).toContainEqual({ kind: 'paragraph', text: 'Speaker notes: Mention the migration first', page: 1 });
    expect(doc.elements.filter((e) => e.kind === 'paragraph' && e.text.startsWith('Speaker'))).toHaveLength(1);
  });

  it('skips empty notes and shapes without text', async () => {
    const a = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    const buf = await zipOf({
      'ppt/slides/slide1.xml': `<p:sld ${a}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr></p:sp></p:spTree></p:cSld></p:sld>`,
      'ppt/slides/slide2.xml': `<p:sld ${a}></p:sld>`,
      'ppt/notesSlides/notesSlide1.xml': `<p:notes ${a}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp></p:spTree></p:cSld></p:notes>`,
    });
    const doc = await createOfficeExtractor({ includeSpeakerNotes: true }).extract(src(buf, PPTX), {});
    expect(doc.elements).toEqual([
      { kind: 'heading', level: 1, text: 'Slide 1', page: 1 },
      { kind: 'heading', level: 1, text: 'Slide 2', page: 2 },
    ]);
  });
});

describe('limits (fail fast, typed errors)', () => {
  it('rejects a file over maxFileBytes (buffer and stream)', async () => {
    const x = createOfficeExtractor({ limits: { maxFileBytes: 100 } });
    expect(await code(x.extract(src(fx('sample.docx'), DOCX), {}))).toBe('FILE_TOO_LARGE');
    expect(await code(x.extract(src(Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), DOCX), {}))).toBe('FILE_TOO_LARGE');
  });

  it('counts string chunks from a stream', async () => {
    const x = createOfficeExtractor({ limits: { maxFileBytes: 10 } });
    expect(await code(x.extract(src(Readable.from(['x'.repeat(20)]), DOCX), {}))).toBe('FILE_TOO_LARGE');
  });

  it('rejects too many entries', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`f${i}.txt`] = `${i}`;
    const x = createOfficeExtractor({ limits: { maxEntries: 10 } });
    expect(await code(x.extract(src(await zipOf(files), DOCX), {}))).toBe('TOO_MANY_ENTRIES');
  });

  it('rejects excessive total uncompressed size', async () => {
    const buf = await zipOf({ 'a.xml': 'abcdefgh'.repeat(2000), 'b.xml': 'abcdefgh'.repeat(2000) });
    const x = createOfficeExtractor({ limits: { maxUncompressedBytes: 20_000, maxCompressionRatio: 1e9 } });
    expect(await code(x.extract(src(buf, DOCX), {}))).toBe('UNCOMPRESSED_TOO_LARGE');
  });

  it('rejects a zip bomb by compression ratio', async () => {
    const buf = await zipOf({ 'ppt/slides/slide1.xml': Buffer.alloc(5_000_000) });
    expect(buf.length).toBeLessThan(10_000);
    expect(await code(createOfficeExtractor().extract(src(buf, PPTX), {}))).toBe('COMPRESSION_RATIO');
  });

  it('does not inflate a bomb before rejecting it', async () => {
    const buf = await zipOf({ 'word/document.xml': Buffer.alloc(50_000_000) });
    const t = Date.now();
    expect(await code(createOfficeExtractor().extract(src(buf, DOCX), {}))).toBe('COMPRESSION_RATIO');
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('rejects non-zip and corrupt input', async () => {
    const x = createOfficeExtractor();
    expect(await code(x.extract(src(Buffer.from('not a zip'), DOCX), {}))).toBe('INVALID_ARCHIVE');
    const rnd = Array.from({ length: 3000 }, (_, i) => String.fromCharCode(97 + ((i * 7919) % 26))).join('');
    const good = await zipOf({ 'ppt/slides/slide1.xml': `<p:sld>${rnd}</p:sld>` });
    const bad = Buffer.from(good);
    bad.fill(0xff, 60, 140); // damage the deflate stream of the only entry
    expect(await code(x.extract(src(bad, PPTX), {}))).toBe('INVALID_ARCHIVE');
  });

  it('rejects an entry whose real size differs from the size declared in the directory', async () => {
    const buf = Buffer.from(await zipOf({ 'ppt/slides/slide1.xml': `<p:sld>${'ab'.repeat(500)}</p:sld>` }));
    const idx = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(buf.readUInt32LE(idx + 24) - 10, idx + 24); // understate the uncompressed size
    expect(await code(createOfficeExtractor().extract(src(buf, PPTX), {}))).toBe('INVALID_ARCHIVE');
  });

  it('rejects a DOCX/XLSX whose deflate streams inflate past the declared sizes, before the parser runs', async () => {
    // ~20 MB of zeros declared as 1000 bytes: passes the directory checks, so only inflating with size validation catches it.
    const bomb = async (name: string) => {
      const buf = Buffer.from(await zipOf({ [name]: Buffer.alloc(20_000_000) }));
      const local = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      buf.writeUInt32LE(1000, local + 22);
      const central = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      buf.writeUInt32LE(1000, central + 24);
      return buf;
    };
    const convert = jest.spyOn(mammoth, 'convertToHtml');
    const load = jest.spyOn(ExcelJS.Workbook.prototype, 'xlsx', 'get');
    try {
      expect(await code(createOfficeExtractor().extract(src(await bomb('word/document.xml'), DOCX), {}))).toBe('INVALID_ARCHIVE');
      expect(await code(createOfficeExtractor().extract(src(await bomb('xl/workbook.xml'), XLSX), {}))).toBe('INVALID_ARCHIVE');
      expect(convert).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    } finally {
      convert.mockRestore();
      load.mockRestore();
    }
  });

  it('rejects unsupported types', async () => {
    expect(await code(createOfficeExtractor().extract(src(Buffer.alloc(1), 'text/plain'), {}))).toBe('UNSUPPORTED_TYPE');
  });

  it('validates limit configuration eagerly', () => {
    expect(() => createOfficeExtractor({ limits: { timeoutMs: 0 } })).toThrow(/timeoutMs/);
    expect(() => createOfficeExtractor({ limits: { maxEntries: NaN } })).toThrow(/maxEntries/);
  });
});

describe('abort and timeout', () => {
  it('rejects immediately with ABORTED when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await code(createOfficeExtractor().extract(src(fx('sample.docx'), DOCX), {}, ac.signal))).toBe('ABORTED');
  });

  it('rejects with ABORTED when aborted mid-flight', async () => {
    const ac = new AbortController();
    const p = createOfficeExtractor().extract(src(fx('sample.xlsx'), XLSX), {}, ac.signal);
    ac.abort();
    expect(await code(p)).toBe('ABORTED');
  });

  it('rejects with TIMEOUT when the deadline passes', async () => {
    const slow = new Readable({ read() { /* never produces data */ } });
    const t = Date.now();
    expect(await code(createOfficeExtractor({ limits: { timeoutMs: 50 } }).extract(src(slow, DOCX), {}))).toBe('TIMEOUT');
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it('stops between slides once the deadline has passed', async () => {
    const x = createOfficeExtractor({ limits: { timeoutMs: 1 } });
    const spin = Date.now();
    while (Date.now() - spin < 5); // ensure the 1 ms deadline elapsed before work starts
    expect(await code(x.extract(src(fx('sample.pptx'), PPTX), {}))).toBe('TIMEOUT');
  });
});
