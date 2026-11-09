import { Readable } from 'stream';
import { approximateTokenCounter, exactTokenCounter } from './tokenizer';
import { renderElement, renderMarkdown, renderTable, tableAsCsv, tableAsMarkdown } from './render';
import { markdownExtractor, txtExtractor } from './extractors';
import { DocumentSource } from './models';

const src = (content: Buffer | NodeJS.ReadableStream, contentType: string, fileName?: string): DocumentSource => ({
  documentId: 'd1', content, contentType, fileName, documentVersion: 1, tenantId: 't', aclGroups: [],
});
const buf = (s: string) => Buffer.from(s, 'utf8');

describe('token counters', () => {
  it('exact counter matches known BPE counts and handles empty text', () => {
    const c = exactTokenCounter();
    expect(c.count('')).toBe(0);
    expect(c.count('hello world')).toBe(2);
    expect(c.exact).toBe(true);
    expect(c.safetyMarginPercent).toBe(5);
  });
  it('approximate counter is chars/4 rounded up with a larger margin', () => {
    const c = approximateTokenCounter();
    expect(c.count('')).toBe(0);
    expect(c.count('abcde')).toBe(2);
    expect(c.exact).toBe(false);
    expect(c.safetyMarginPercent).toBe(15);
  });
});

describe('renderer', () => {
  it('renders each element kind compactly', () => {
    const c = exactTokenCounter();
    expect(renderElement({ kind: 'heading', level: 2, text: 'T' }, c)).toBe('## T');
    expect(renderElement({ kind: 'heading', level: 9, text: 'T' }, c)).toBe('###### T');
    expect(renderElement({ kind: 'heading', level: 0, text: 'T' }, c)).toBe('# T');
    expect(renderElement({ kind: 'paragraph', text: 'p' }, c)).toBe('p');
    expect(renderElement({ kind: 'list', items: ['a', 'b'], ordered: false }, c)).toBe('- a\n- b');
    expect(renderElement({ kind: 'list', items: ['a', 'b'], ordered: true }, c)).toBe('1. a\n2. b');
    expect(renderElement({ kind: 'code', text: 'x=1', language: 'js' }, c)).toBe('```js\nx=1\n```');
    expect(renderElement({ kind: 'code', text: 'x=1' }, c)).toBe('```\nx=1\n```');
    expect(renderElement({ kind: 'image', caption: 'cat' }, c)).toBe('[Image: cat]');
    expect(renderElement({ kind: 'image' }, c)).toBe('');
  });
  it('escapes pipes/quotes in table cells', () => {
    expect(tableAsMarkdown(['a'], [['x|y']])).toBe('| a |\n| --- |\n| x\\|y |');
    expect(tableAsCsv(['a', 'b'], [['x,y', 'he said "hi"'], ['l1\nl2', 'ok']])).toBe('a,b\n"x,y","he said ""hi"""\n"l1\nl2",ok');
  });
  it('picks whichever table encoding has fewer tokens', () => {
    const c = exactTokenCounter();
    const header = ['id', 'name', 'city'];
    const rows = Array.from({ length: 20 }, (_, i) => [`${i}`, `n${i}`, `c${i}`]);
    const out = renderTable(header, rows, c);
    const md = tableAsMarkdown(header, rows);
    const csv = tableAsCsv(header, rows);
    expect(c.count(csv)).toBeLessThan(c.count(md));
    expect(out).toBe(csv);
    // a counter that favours markdown (and tie → markdown)
    expect(renderTable(header, rows, { count: (t) => (t === csv ? 100 : 1) })).toBe(md);
    expect(renderTable(header, rows, { count: () => 5 })).toBe(md);
  });
  it('joins non-empty elements with blank lines', () => {
    const out = renderMarkdown(
      [{ kind: 'heading', level: 1, text: 'A' }, { kind: 'image' }, { kind: 'paragraph', text: 'b' }],
      exactTokenCounter(),
    );
    expect(out).toBe('# A\n\nb');
  });
});

describe('txtExtractor', () => {
  const x = txtExtractor();
  it('detects by content type or extension', () => {
    expect(x.canExtract('text/plain; charset=utf-8')).toBe(true);
    expect(x.canExtract('', 'a.TXT')).toBe(true);
    expect(x.canExtract('', undefined)).toBe(false);
    expect(x.canExtract('application/pdf', 'a.txt')).toBe(false);
  });
  it('splits paragraphs on blank lines, strips BOM, hashes bytes, fills stats', async () => {
    const text = '\uFEFFFirst line\r\nwrapped\r\n\r\n\r\nSecond para\n  \nThird';
    const doc = await x.extract(src(buf(text), 'text/plain'), {});
    expect(doc.elements).toEqual([
      { kind: 'paragraph', text: 'First line wrapped' },
      { kind: 'paragraph', text: 'Second para' },
      { kind: 'paragraph', text: 'Third' },
    ]);
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await x.extract(src(buf(text), 'text/plain'), {});
    expect(again.contentHash).toBe(doc.contentHash);
    const other = await x.extract(src(buf(text + '!'), 'text/plain'), {});
    expect(other.contentHash).not.toBe(doc.contentHash);
    expect(doc.stats.rawChars).toBe(text.length - 1);
    expect(doc.stats.rawTokens).toBeGreaterThan(0);
  });
  it('reads streams (string and buffer chunks) and uses a supplied token counter', async () => {
    const stream = Readable.from(['Hello ', buf('world')]);
    const doc = await x.extract(src(stream, 'text/plain'), { tokenCounter: { count: () => 42 } });
    expect(doc.elements).toEqual([{ kind: 'paragraph', text: 'Hello world' }]);
    expect(doc.stats.rawTokens).toBe(42);
  });
});

describe('markdownExtractor', () => {
  const x = markdownExtractor();
  it('detects by content type or extension', () => {
    expect(x.canExtract('text/markdown')).toBe(true);
    expect(x.canExtract('text/x-markdown')).toBe(true);
    expect(x.canExtract('text/plain', 'a.md')).toBe(true);
    expect(x.canExtract('', 'a.markdown')).toBe(true);
    expect(x.canExtract('text/plain', 'a.txt')).toBe(false);
    expect(x.canExtract('', undefined)).toBe(false);
  });
  it('maps headings, paragraphs, lists, tables, code, images, quotes; drops chrome', async () => {
    const md = [
      '# Title', '', 'Some *emphasised* text with `code` and a [link](http://x).  ', 'second line', '',
      '1. one', '2. two', '', '- a', '- b', '',
      '| h1 | h2 |', '|----|----|', '| 1 | **2** |', '| 3 | 4 |', '',
      '```ts', 'const a = 1;', '```', '', '    indented', '',
      '![A cat](c.png)', '', '![](nocaption.png)', '',
      '> quoted para', '', '---', '', '<div>html</div>', '',
    ].join('\n');
    const doc = await x.extract(src(buf(md), 'text/markdown'), {});
    expect(doc.elements).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'paragraph', text: 'Some emphasised text with code and a link. second line' },
      { kind: 'list', ordered: true, items: ['one', 'two'] },
      { kind: 'list', ordered: false, items: ['a', 'b'] },
      { kind: 'table', header: ['h1', 'h2'], rows: [['1', '2'], ['3', '4']] },
      { kind: 'code', text: 'const a = 1;', language: 'ts' },
      { kind: 'code', text: 'indented' },
      { kind: 'image', caption: 'A cat' },
      { kind: 'paragraph', text: 'quoted para' },
    ]);
    expect(doc.stats.elementsDropped).toBe(3); // captionless image, rule, html
  });
  it('round-trips through the compact renderer', async () => {
    const doc = await x.extract(src(buf('# A\n\ntext\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'), 'text/markdown'), {});
    expect(renderMarkdown(doc.elements, exactTokenCounter())).toContain('# A\n\ntext\n\n');
  });
  it('handles empty input, empty paragraphs and header-less tables safely', async () => {
    const doc = await x.extract(src(buf(''), 'text/markdown'), {});
    expect(doc.elements).toEqual([]);
    const s = await x.extract(src(Readable.from([buf('\uFEFF# H\n\n\\\n')]), 'text/markdown'), {});
    expect(s.elements[0]).toEqual({ kind: 'heading', level: 1, text: 'H' });
  });
});
