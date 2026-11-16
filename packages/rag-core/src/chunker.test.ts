import { structureChunker, splitText } from './chunker';
import { DocumentChunk, DocumentElement, ExtractedDocument, TokenCounter } from './models';
import { exactTokenCounter } from './tokenizer';

const words: TokenCounter = { count: (t) => t.split(/\s+/).filter(Boolean).length };
const mk = (elements: DocumentElement[], documentId = 'doc'): ExtractedDocument => ({
  documentId, contentHash: 'h', elements,
  stats: { rawChars: 0, rawTokens: 0, elementsDropped: 0, pagesNeedingOcr: [] },
});
const H = (level: number, text: string): DocumentElement => ({ kind: 'heading', level, text });
const P = (text: string, page?: number): DocumentElement => ({ kind: 'paragraph', text, ...(page ? { page } : {}) });
const run = async (doc: ExtractedDocument, target: number, max: number, counter: TokenCounter = words, extra = {}) => {
  const out: DocumentChunk[] = [];
  for await (const c of structureChunker({ tokenCounter: counter, ...extra }).chunk(doc, { targetTokens: target, maxTokens: max, overlapTokens: 0 })) out.push(c);
  return out;
};
const leaves = (cs: DocumentChunk[]) => cs.filter((c) => c.metadata?.role === 'leaf');
const sentence = (n: number, tag = 'w') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ') + '.';

describe('structureChunker — structure & prefix', () => {
  it('prefixes the heading path, tracks nesting, and starts a new chunk per section', async () => {
    const cs = await run(
      mk([P('intro text'), H(1, 'Leave'), P('Leave overview'), H(2, 'Sick'), P('Sick days'), H(2, 'Annual'), P('Annual days'), H(1, 'Pay'), P('Pay text')]),
      50, 100,
    );
    expect(cs.map((c) => c.headingPath)).toEqual([[], ['Leave'], ['Leave', 'Sick'], ['Leave', 'Annual'], ['Pay']]);
    expect(cs[0].text).toBe('intro text');
    expect(cs[2].text).toBe('Leave > Sick\n\nSick days');
    expect(cs.map((c) => c.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(cs[2].tokenCount).toBe(words.count(cs[2].text));
    expect(cs.every((c) => c.metadata?.role === 'leaf')).toBe(true);
  });

  it('skips empty sections and empty documents', async () => {
    expect(await run(mk([]), 10, 20)).toEqual([]);
    expect(await run(mk([H(1, 'Only heading'), H(2, 'Another')]), 10, 20)).toEqual([]);
  });

  it('packs small blocks of one section together up to targetTokens only', async () => {
    const cs = await run(mk([H(1, 'T'), P('a b c'), P('d e f'), P('g h i')]), 9, 20); // prefix "T" costs 1 token
    expect(leaves(cs).map((c) => c.text)).toEqual(['T\n\na b c\n\nd e f', 'T\n\ng h i']);
    expect(leaves(cs).map((c) => c.tokenCount)).toEqual([7, 4]);
  });

  it('drops a heading prefix that would eat more than half the target (path stays in metadata)', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `h${i}`).join(' ');
    const cs = await run(mk([H(1, long), P('body')]), 20, 40);
    expect(cs[0].text).toBe('body');
    expect(cs[0].headingPath).toEqual([long]);
  });

  it('turns image captions into text and ignores captionless images', async () => {
    const cs = await run(mk([{ kind: 'image', caption: 'a cat' }, { kind: 'image' }]), 10, 20);
    expect(cs.map((c) => c.text)).toEqual(['[Image: a cat]']);
  });

  it('records pageStart/pageEnd from the blocks in a chunk', async () => {
    const cs = await run(mk([P('a', 3), P('b', 5), P('c')]), 10, 20);
    expect(cs[0]).toMatchObject({ pageStart: 3, pageEnd: 5 });
    const none = await run(mk([P('a')]), 10, 20);
    expect(none[0].pageStart).toBeUndefined();
  });
});

describe('structureChunker — budgets', () => {
  it('splits an oversize paragraph at sentence boundaries, never above maxTokens', async () => {
    const para = Array.from({ length: 10 }, (_, i) => sentence(9, `s${i}x`)).join(' ');
    const cs = await run(mk([H(1, 'H'), P(para)]), 25, 30);
    expect(leaves(cs).length).toBeGreaterThan(2);
    for (const c of cs) expect(c.tokenCount).toBeLessThanOrEqual(30);
    for (const c of leaves(cs)) expect(c.tokenCount).toBeLessThanOrEqual(25);
    // every sentence survives intact in exactly one leaf
    const body = leaves(cs).map((c) => c.text.replace('H\n\n', '')).join(' ');
    expect(body.replace(/\s+/g, ' ')).toBe(para);
  });

  it('keeps a paragraph between target and max whole', async () => {
    const cs = await run(mk([P(sentence(15))]), 10, 20);
    expect(cs).toHaveLength(1);
    expect(cs[0].tokenCount).toBe(15);
  });

  it('splits sentence-less text by words and unbroken text by code points', async () => {
    const noPunct = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const a = await run(mk([P(noPunct)]), 10, 12);
    expect(a.every((c) => c.tokenCount <= 12)).toBe(true);
    expect(a.map((c) => c.text).join(' ')).toBe(noPunct);

    const blob = 'x'.repeat(500) + '😀'.repeat(50);
    const b = await run(mk([P(blob)]), 20, 25, exactTokenCounter());
    expect(b.every((c) => c.tokenCount <= 25)).toBe(true);
    expect(b.map((c) => c.text).join('')).toBe(blob);
  });

  it('splitText returns the text unchanged when it already fits', () => {
    expect(splitText('short', () => true)).toEqual(['short']);
  });

  it('never exceeds maxTokens with the exact tokenizer on a messy mixed document', async () => {
    const doc = mk([
      H(1, 'Policy handbook'), P(sentence(400, 'alpha')),
      H(2, 'Tables'), { kind: 'table', header: ['id', 'name', 'notes'], rows: Array.from({ length: 300 }, (_, i) => [`${i}`, `n${i}`, `note ${i} with some words`]) },
      H(2, 'Code'), { kind: 'code', language: 'ts', text: Array.from({ length: 200 }, (_, i) => `const v${i} = ${i} + ${i};`).join('\n') },
      H(2, 'List'), { kind: 'list', ordered: true, items: Array.from({ length: 150 }, (_, i) => `item number ${i} text`) },
      P('ünïcödé ' + '日本語'.repeat(300)),
    ]);
    const cs = await run(doc, 120, 160, exactTokenCounter());
    expect(cs.length).toBeGreaterThan(10);
    for (const c of cs) {
      expect(c.tokenCount).toBeLessThanOrEqual(160);
      expect(c.tokenCount).toBe(exactTokenCounter().count(c.text));
    }
  });
});

describe('structureChunker — tables and code', () => {
  const table = (n: number): DocumentElement => ({
    kind: 'table', header: ['id', 'value'], rows: Array.from({ length: n }, (_, i) => [`r${i}`, `v${i}`]),
  });

  it('keeps a table that fits within maxTokens in a single chunk (even above target)', async () => {
    const cs = await run(mk([table(6)]), 10, 40);
    expect(cs).toHaveLength(1);
    for (let i = 0; i < 6; i++) expect(cs[0].text).toContain(`r${i}`);
  });

  it('splits an oversize table by row groups with the header repeated and no row split', async () => {
    const cs = await run(mk([H(1, 'T'), table(40)]), 30, 40, exactTokenCounter());
    const ls = leaves(cs);
    expect(ls.length).toBeGreaterThan(1);
    const seen: string[] = [];
    for (const c of ls) {
      expect(c.tokenCount).toBeLessThanOrEqual(40);
      const body = c.text.replace('T\n\n', '');
      expect(/^(\| id \| value \||id,value)/.test(body)).toBe(true); // header repeated
      for (const m of body.matchAll(/r(\d+)/g)) seen.push(m[1]);
    }
    expect(seen.map(Number)).toEqual(Array.from({ length: 40 }, (_, i) => i)); // each row exactly once, in order
  });

  it('applies the row cap with an "N rows omitted" note', async () => {
    const cs = await run(mk([table(10)]), 100, 200, words, { maxTableRows: 4 });
    const text = cs.map((c) => c.text).join('\n');
    expect(text).toContain('r3');
    expect(text).not.toContain('r4');
    expect(text).toContain('[6 rows omitted]');
  });

  it('falls back to splitting the bare row text when header + one row exceed the budget', async () => {
    const big = Array.from({ length: 60 }, (_, i) => `cell${i}`).join(' ');
    const cs = await run(mk([{ kind: 'table', header: ['a'], rows: [[big], ['small']] }]), 10, 12);
    expect(cs.every((c) => c.tokenCount <= 12)).toBe(true);
    expect(cs.map((c) => c.text).join(' ')).toContain('cell59');
  });

  it('never splits a fitting code block, and splits oversize code into balanced fences', async () => {
    const code = (n: number): DocumentElement => ({ kind: 'code', language: 'js', text: Array.from({ length: n }, (_, i) => `let a${i} = ${i};`).join('\n') });
    const small = await run(mk([P('before'), code(3)]), 100, 200);
    expect(small).toHaveLength(1);
    expect(small[0].text).toContain('```js\nlet a0 = 0;\nlet a1 = 1;\nlet a2 = 2;\n```');

    const big = await run(mk([code(100)]), 40, 60, exactTokenCounter());
    expect(big.length).toBeGreaterThan(1);
    const lines: string[] = [];
    for (const c of big) {
      expect(c.tokenCount).toBeLessThanOrEqual(60);
      expect(c.text.startsWith('```js\n') && c.text.endsWith('\n```')).toBe(true);
      lines.push(...c.text.split('\n').slice(1, -1));
    }
    expect(lines).toEqual(Array.from({ length: 100 }, (_, i) => `let a${i} = ${i};`));
  });

  it('splits an over-long code line and handles code without language', async () => {
    const line = Array.from({ length: 50 }, (_, i) => `tok${i}`).join(' ');
    const cs = await run(mk([{ kind: 'code', text: `${line}\nend` }]), 10, 14);
    expect(cs.every((c) => c.tokenCount <= 14 && c.text.startsWith('```\n'))).toBe(true);
  });

  it('splits oversize lists by item groups and oversize items by sentence', async () => {
    const items = Array.from({ length: 30 }, (_, i) => `item ${i} here`);
    const cs = await run(mk([{ kind: 'list', ordered: false, items }]), 12, 15);
    expect(cs.length).toBeGreaterThan(1);
    expect(cs.every((c) => c.tokenCount <= 15)).toBe(true);
    expect(cs.flatMap((c) => c.text.split('\n'))).toEqual(items.map((i) => `- ${i}`));

    const long = await run(mk([{ kind: 'list', ordered: true, items: [sentence(20) + ' ' + sentence(20, 'z'), 'short'] }]), 12, 15);
    expect(long.every((c) => c.tokenCount <= 15)).toBe(true);
    expect(long[long.length - 1].text).toContain('2. short');
  });
});

describe('structureChunker — ids', () => {
  const base = [H(1, 'A'), P('alpha text'), H(1, 'B'), P('beta text'), H(1, 'C'), P('gamma text')];

  it('is deterministic and scoped by documentId', async () => {
    const a = await run(mk(base), 50, 100);
    const b = await run(mk(base), 50, 100);
    expect(a.map((c) => c.chunkId)).toEqual(b.map((c) => c.chunkId));
    const other = await run(mk(base, 'other'), 50, 100);
    expect(other[0].chunkId).not.toBe(a[0].chunkId);
    expect(other[0].contentHash).toBe(a[0].contentHash);
    expect(a[0].chunkId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps later chunk ids stable when a section/paragraph is inserted earlier', async () => {
    const before = await run(mk(base), 50, 100);
    const inserted = [H(1, 'A'), P('alpha text'), P('brand new paragraph'), H(1, 'A2'), P('new section'), ...base.slice(2)];
    const after = await run(mk(inserted), 50, 100);
    const idOf = (cs: DocumentChunk[], p: string) => cs.find((c) => c.text.includes(p))?.chunkId;
    expect(idOf(after, 'beta text')).toBe(idOf(before, 'beta text'));
    expect(idOf(after, 'gamma text')).toBe(idOf(before, 'gamma text'));
    expect(idOf(after, 'brand new')).toBeDefined();
  });

  it('gives identical chunks distinct ids via the occurrence counter, stable across runs', async () => {
    const doc = mk([H(1, 'A'), P('same'), H(1, 'A'), P('same')]);
    const cs = await run(doc, 50, 100);
    expect(cs[0].contentHash).toBe(cs[1].contentHash);
    expect(cs[0].chunkId).not.toBe(cs[1].chunkId);
    expect((await run(doc, 50, 100)).map((c) => c.chunkId)).toEqual(cs.map((c) => c.chunkId));
  });
});

describe('structureChunker — parent/child', () => {
  it('emits a parent covering consecutive leaves that fit maxTokens, referenced by each child', async () => {
    const cs = await run(mk([H(1, 'T'), P('a b c d'), P('e f g h'), P('i j k l')]), 6, 20);
    const parents = cs.filter((c) => c.metadata?.role === 'parent');
    const ls = leaves(cs);
    expect(ls).toHaveLength(3);
    expect(parents).toHaveLength(1);
    expect(parents[0].tokenCount).toBeLessThanOrEqual(20);
    expect(parents[0].parentChunkId).toBeUndefined();
    for (const l of ls) {
      expect(l.parentChunkId).toBe(parents[0].chunkId);
      expect(parents[0].text).toContain(l.text.replace('T\n\n', ''));
    }
    expect(cs[0]).toBe(parents[0]); // parent precedes its children
  });

  it('starts a new parent when the next leaf would push it over maxTokens; lone leaves get none', async () => {
    const cs = await run(mk([P('a b c d e f'), P('g h i j k l'), P('m n o p q r')]), 6, 13);
    const parents = cs.filter((c) => c.metadata?.role === 'parent');
    expect(parents).toHaveLength(1); // first two leaves (12 tokens + sep) share a parent
    const ls = leaves(cs);
    expect(ls[0].parentChunkId).toBe(parents[0].chunkId);
    expect(ls[1].parentChunkId).toBe(parents[0].chunkId);
    expect(ls[2].parentChunkId).toBeUndefined();
  });
});

describe('structureChunker — validation & abort', () => {
  it('never exceeds a tiny maxTokens: drops code fences that alone exceed it, and refuses impossible budgets', async () => {
    const counter = exactTokenCounter();
    const code: DocumentElement = { kind: 'code', language: 'typescript', text: 'const a = 1;\nconst b = 2;' };
    const cs = await run(mk([code]), 4, 4, counter);
    expect(cs.length).toBeGreaterThan(1);
    for (const c of cs) expect(c.tokenCount).toBeLessThanOrEqual(4);
    const all = leaves(cs).map((c) => c.text).join(' ');
    expect(all).not.toContain('```');
    expect(all.replace(/\s+/g, '')).toBe('consta=1;constb=2;');
    // a single code point costs more than maxTokens: no valid chunking exists, so fail loudly
    const twoPerCp: TokenCounter = { count: (t) => Array.from(t).length * 2 };
    await expect(run(mk([P('ab')]), 1, 1, twoPerCp)).rejects.toThrow(/too small/);
  });

  it('rejects invalid budgets and unsupported overlap', async () => {
    await expect(run(mk([P('a')]), 0, 10)).rejects.toThrow(/targetTokens/);
    await expect(run(mk([P('a')]), 20, 10)).rejects.toThrow(/targetTokens/);
    await expect(run(mk([P('a')]), 1.5, 10)).rejects.toThrow(/integers/);
    const it = structureChunker().chunk(mk([P('a')]), { targetTokens: 10, maxTokens: 20, overlapTokens: 3 });
    await expect(it[Symbol.asyncIterator]().next()).rejects.toThrow(/overlap/);
  });

  it('defaults to the exact tokenizer and honours an aborted signal', async () => {
    const out: DocumentChunk[] = [];
    for await (const c of structureChunker().chunk(mk([P('hello world')]), { targetTokens: 10, maxTokens: 20, overlapTokens: 0 })) out.push(c);
    expect(out[0].tokenCount).toBe(2);
    const ac = new AbortController();
    ac.abort();
    const it = structureChunker().chunk(mk([P('x')]), { targetTokens: 10, maxTokens: 20, overlapTokens: 0 }, ac.signal);
    await expect(it[Symbol.asyncIterator]().next()).rejects.toThrow();
  });
});
