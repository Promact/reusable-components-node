import { createRag } from './createRag';
import { markdownExtractor } from './extractors';
import { memoryVectorStore } from './memoryStore';
import { DocumentChunk, DocumentSource, EmbeddingModel, ScoredChunk, SearchRequest, TokenCounter, VectorStore } from './models';
import { contextLimit, createKnowledgeRetriever, DEFAULT_CONTEXT_TOKENS, edgeOrder, packContext } from './packer';
import { assertRetrievalFilter, cosineSimilarity, createRetriever, mmr } from './retriever';
import { approximateTokenCounter, exactTokenCounter } from './tokenizer';

const DIMS = 16;
function fakeEmbeddings(): EmbeddingModel & { calls: number } {
  const m = {
    modelId: 'fake-1', dimensions: DIMS, calls: 0,
    async embed(texts: string[]) {
      m.calls++;
      return texts.map((t) => {
        const v = new Float32Array(DIMS);
        for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          let h = 0;
          for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          v[h % DIMS] += 1;
        }
        return v;
      });
    },
  };
  return m;
}

const src = (text: string, over: Partial<DocumentSource> = {}): DocumentSource => ({
  documentId: 'doc1', content: Buffer.from(text), contentType: 'text/markdown', documentVersion: 1,
  tenantId: 'acme', aclGroups: ['hr'], ...over,
});

function rag(store: VectorStore = memoryVectorStore()) {
  return createRag({
    collection: 'kb', chunking: { targetTokens: 40, maxTokens: 80, overlapTokens: 0 }, extractors: [markdownExtractor()],
    embeddings: fakeEmbeddings(), vectorStore: store,
  });
}

const words: TokenCounter = { count: (t) => t.split(/\s+/).filter(Boolean).length };
const chunk = (id: string, text: string, over: Partial<DocumentChunk> = {}): DocumentChunk => ({
  chunkId: id, documentId: 'd', ordinal: 0, text, tokenCount: words.count(text), headingPath: [], contentHash: `h-${id}`, ...over,
});
const sc = (c: DocumentChunk, score: number, vector?: number[]): ScoredChunk => ({ chunk: c, score, ...(vector ? { vector: Float32Array.from(vector) } : {}) });

describe('retrieval security', () => {
  it('never leaks another tenant\'s chunks, even with the same documentId, groups and wording', async () => {
    const r = rag();
    await r.ingest(src('# Salaries\n\nThe salary band for engineers is acme-secret-alpha.', { tenantId: 'acme' }));
    await r.ingest(src('# Salaries\n\nThe salary band for engineers is globex-secret-omega.', { tenantId: 'globex' }));
    for (const mode of ['vector', 'keyword', 'hybrid'] as const) {
      const a = await r.getContext({ text: 'salary band engineers globex secret omega', filter: { tenantId: 'acme', aclGroups: ['hr'] }, mode }, { maxTokens: 4000 });
      expect(a.text).toContain('acme-secret-alpha');
      expect(a.text).not.toContain('globex');
      const g = await r.getContext({ text: 'salary band engineers acme secret alpha', filter: { tenantId: 'globex', aclGroups: ['hr'] }, mode }, { maxTokens: 4000 });
      expect(g.text).toContain('globex-secret-omega');
      expect(g.text).not.toContain('acme');
    }
  });

  it('trims by ACL group and returns nothing for a principal without groups', async () => {
    const r = rag();
    await r.ingest(src('# Pay\n\nPayroll details for staff.', { documentId: 'pay', aclGroups: ['hr'] }));
    await r.ingest(src('# Wiki\n\nPayroll how-to for staff.', { documentId: 'wiki', aclGroups: ['all'] }));
    const eng = await r.getContext({ text: 'payroll staff', filter: { tenantId: 'acme', aclGroups: ['all'] } }, { maxTokens: 4000 });
    expect(eng.text).toContain('how-to');
    expect(eng.text).not.toContain('details');
    const none = await r.getContext({ text: 'payroll staff', filter: { tenantId: 'acme', aclGroups: [] } }, { maxTokens: 4000 });
    expect(none).toMatchObject({ text: '', citations: [], tokensUsed: 0, chunksIncluded: 0 });
  });

  it('passes the filter into the store query and never searches without it', async () => {
    const inner = memoryVectorStore();
    const requests: SearchRequest[] = [];
    const spy: VectorStore = { ...inner, search: (c, req, s) => { requests.push(req); return inner.search(c, req, s); } };
    const r = rag(spy);
    await r.ingest(src('# A\n\nalpha text'));
    await r.getContext({ text: 'alpha', filter: { tenantId: 'acme', aclGroups: ['hr'] } }, { maxTokens: 100 });
    expect(requests).toHaveLength(1);
    expect(requests[0].filter).toEqual({ tenantId: 'acme', aclGroups: ['hr'] });
    for (const filter of [undefined, {}, { tenantId: 'acme' }, { tenantId: ' ', aclGroups: [] }, { tenantId: 'acme', aclGroups: [1] }]) {
      await expect(r.getContext({ text: 'alpha', filter: filter as never }, { maxTokens: 100 })).rejects.toThrow(/filter/);
    }
    expect(requests).toHaveLength(1);
    expect(() => assertRetrievalFilter({ tenantId: 't', aclGroups: [] })).not.toThrow();
  });

  it('getByIds applies tenant and ACL filters (parents cannot be fetched across tenants)', async () => {
    const s = memoryVectorStore();
    await s.ensureCollection({ name: 'c', dimensions: 1, modelId: 'm' });
    const rec = (tenantId: string, acl: string[]) => ({ chunk: chunk('p', `${tenantId} text`), vector: Float32Array.from([1]), modelId: 'm', tenantId, aclGroups: acl, documentVersion: 1 });
    await s.upsert('c', [rec('t1', ['g1']), rec('t2', ['g1'])]);
    expect((await s.getByIds('c', { tenantId: 't1', aclGroups: ['g1'] }, ['p', 'p', 'missing'])).map((c) => c.text)).toEqual(['t1 text']);
    expect(await s.getByIds('c', { tenantId: 't1', aclGroups: ['g2'] }, ['p'])).toEqual([]);
    await expect(s.getByIds('c', { tenantId: '', aclGroups: [] }, ['p'])).rejects.toThrow(/getByIds requires/);
  });
});

describe('retriever', () => {
  const store = (caps: Partial<VectorStore['capabilities']>, hits: ScoredChunk[] = []) => {
    const requests: SearchRequest[] = [];
    const s = {
      capabilities: { hybrid: true, keyword: true, returnsVectors: true, ...caps },
      search: async (_c: string, req: SearchRequest) => { requests.push(req); return hits; },
    } as unknown as VectorStore;
    return { s, requests };
  };
  const filter = { tenantId: 't', aclGroups: ['g'] };

  it('degrades hybrid to vector with a one-time warning; rejects unsupported keyword and graph modes', async () => {
    const { s, requests } = store({ hybrid: false, keyword: false });
    const warn = jest.fn();
    const r = createRetriever({ collection: 'c', embeddings: fakeEmbeddings(), vectorStore: s, warn });
    await r.retrieve({ text: 'q', filter });
    await r.retrieve({ text: 'q', filter, mode: 'hybrid' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(requests.map((q) => q.mode)).toEqual(['vector', 'vector']);
    expect(requests[0].vector).toHaveLength(DIMS);
    await expect(r.retrieve({ text: 'q', filter, mode: 'keyword' })).rejects.toThrow(/keyword/);
    for (const mode of ['graph-local', 'graph-global', 'mix'] as const) await expect(r.retrieve({ text: 'q', filter, mode })).rejects.toThrow(/GraphRAG/);
  });

  it('keyword mode does not embed; MMR widens the candidate fetch up to the cap', async () => {
    const { s, requests } = store({});
    const emb = fakeEmbeddings();
    const r = createRetriever({ collection: 'c', embeddings: emb, vectorStore: s });
    await r.retrieve({ text: 'q', filter, mode: 'keyword', topK: 5 });
    expect(emb.calls).toBe(0);
    expect(requests[0]).toMatchObject({ topK: 15, vector: undefined });
    await r.retrieve({ text: 'q', filter, topK: 40 });
    expect(requests[1].topK).toBe(50);
    await r.retrieve({ text: 'q', filter, topK: 60 });
    expect(requests[2].topK).toBe(60);
    await r.retrieve({ text: 'q', filter, topK: 5, mmr: { enabled: false, lambda: 0 } });
    expect(requests[3].topK).toBe(5);
  });

  it('validates the query and the query embedding', async () => {
    const { s } = store({});
    const r = createRetriever({ collection: 'c', embeddings: fakeEmbeddings(), vectorStore: s });
    await expect(r.retrieve({ text: ' ', filter })).rejects.toThrow(/text/);
    await expect(r.retrieve({ text: 'q', filter, topK: 0 })).rejects.toThrow(/topK/);
    await expect(r.retrieve({ text: 'q', filter, mmr: { enabled: true, lambda: 2 } })).rejects.toThrow(/lambda/);
    const broken = { modelId: 'x', dimensions: 4, embed: async () => [new Float32Array(2)] };
    await expect(createRetriever({ collection: 'c', embeddings: broken, vectorStore: s }).retrieve({ text: 'q', filter })).rejects.toThrow(/query vector/);
    const ac = new AbortController();
    ac.abort();
    await expect(r.retrieve({ text: 'q', filter }, ac.signal)).rejects.toThrow();
  });

  it('enforces minScore even if the adapter ignores it, and applies MMR for diversity', async () => {
    const hits = [sc(chunk('a', 'a'), 0.9, [1, 0]), sc(chunk('a2', 'a2'), 0.89, [1, 0]), sc(chunk('b', 'b'), 0.8, [0, 1]), sc(chunk('weak', 'w'), 0.1, [0, 1])];
    const { s, requests } = store({}, hits);
    const r = createRetriever({ collection: 'c', embeddings: fakeEmbeddings(), vectorStore: s });
    const out = await r.retrieve({ text: 'q', filter, topK: 2, minScore: 0.5 });
    expect(requests[0].minScore).toBe(0.5);
    expect(out.candidatesConsidered).toBe(3);
    expect(out.candidates.map((c) => c.chunk.chunkId)).toEqual(['a', 'b']); // near-duplicate a2 skipped
    const plain = await r.retrieve({ text: 'q', filter, topK: 2, mmr: { enabled: false, lambda: 0.7 } });
    expect(plain.candidates.map((c) => c.chunk.chunkId)).toEqual(['a', 'a2']);
    const noVectors = createRetriever({ collection: 'c', embeddings: fakeEmbeddings(), vectorStore: store({ returnsVectors: false }, hits).s });
    expect((await noVectors.retrieve({ text: 'q', filter, topK: 2 })).candidates.map((c) => c.chunk.chunkId)).toEqual(['a', 'a2']);
  });

  it('mmr and cosine helpers', () => {
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1]))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([0, 0]), Float32Array.from([1, 0]))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([2, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1);
    const noVec = [sc(chunk('x', 'x'), 0.5), sc(chunk('y', 'y'), 0.4)];
    expect(mmr(noVec, 5, 0.5).map((c) => c.chunk.chunkId)).toEqual(['x', 'y']);
    expect(mmr([], 3, 0.7)).toEqual([]);
  });
});

describe('context packer', () => {
  it('resolves the budget: default 4000, counter margin, explicit margin, validation', () => {
    expect(contextLimit(undefined, exactTokenCounter())).toBe(3800);
    expect(contextLimit({}, approximateTokenCounter())).toBe(3400);
    expect(contextLimit({ maxTokens: 1000 }, words)).toBe(950);
    expect(contextLimit({ maxTokens: 1000, safetyMarginPercent: 0 }, words)).toBe(1000);
    expect(DEFAULT_CONTEXT_TOKENS).toBe(4000);
    expect(() => contextLimit({ maxTokens: 0 }, words)).toThrow(/maxTokens/);
    expect(() => contextLimit({ maxTokens: 10, safetyMarginPercent: 100 }, words)).toThrow(/safetyMargin/);
    expect(() => contextLimit({ maxTokens: 10, format: 'html' as never }, words)).toThrow(/format/);
  });

  it('never exceeds maxTokens − margin, for every budget, with the exact tokenizer', async () => {
    const counter = exactTokenCounter();
    const cands = Array.from({ length: 30 }, (_, i) =>
      sc(chunk(`c${i}`, `Section ${i}\n\n${'lorem ipsum dolor '.repeat(1 + (i % 7))}item ${i}.`, { documentId: `d${i % 4}`, ordinal: i * 3, headingPath: [`Section ${i}`] }), 1 - i / 100));
    for (let max = 1; max <= 400; max += 7) {
      const ctx = await packContext(cands, { maxTokens: max }, { tokenCounter: counter });
      const limit = Math.floor((max * 95) / 100);
      expect(ctx.tokensUsed).toBeLessThanOrEqual(limit);
      expect(counter.count(ctx.text)).toBe(ctx.tokensUsed);
      expect(ctx.chunksIncluded + ctx.chunksDropped).toBe(30);
    }
  });

  it('drops the lowest-scoring chunks first and labels citations [n]', async () => {
    const cands = [sc(chunk('lo', 'low relevance words here', { ordinal: 10 }), 0.2), sc(chunk('hi', 'high relevance', { ordinal: 0 }), 0.9), sc(chunk('mid', 'mid one', { ordinal: 5 }), 0.5)];
    const ctx = await packContext(cands, { maxTokens: 6, safetyMarginPercent: 0 }, { tokenCounter: words });
    expect(ctx.text).toBe('[1] high relevance\n\n[2] mid one');
    expect(ctx.citations).toEqual([
      { label: '[1]', documentId: 'd', chunkId: 'hi', headingPath: [] },
      { label: '[2]', documentId: 'd', chunkId: 'mid', headingPath: [] },
    ]);
    expect(ctx).toMatchObject({ tokensUsed: 6, chunksIncluded: 2, chunksDropped: 1, candidatesConsidered: 3, graphFactsIncluded: 0 });
    expect(await packContext([], undefined, { tokenCounter: words })).toMatchObject({ text: '', tokensUsed: 0, chunksIncluded: 0 });
  });

  it('merges adjacent chunks of one section into one block, stating the heading path once', async () => {
    const path = ['Leave', 'Sick'];
    const pre = 'Leave > Sick\n\n';
    const a = chunk('a', `${pre}first part.`, { ordinal: 1, headingPath: path, pageStart: 3 });
    const b = chunk('b', `${pre}second part.`, { ordinal: 2, headingPath: path });
    const far = chunk('far', `${pre}far part.`, { ordinal: 9, headingPath: path });
    const ctx = await packContext([sc(b, 0.8), sc(far, 0.5), sc(a, 0.9)], { maxTokens: 1000 }, { tokenCounter: words });
    expect(ctx.text).toBe(`[1] ${pre}first part.\n\nsecond part.\n\n[2] ${pre}far part.`);
    expect(ctx.citations.map((c) => [c.label, c.chunkId, c.page])).toEqual([['[1]', 'a', 3], ['[1]', 'b', undefined], ['[2]', 'far', undefined]]);
    // gap of 2 is adjacent only across a parent boundary (b starts a new parent group)
    const x = chunk('x', 'x.', { ordinal: 1, parentChunkId: 'P1' });
    const y = chunk('y', 'y.', { ordinal: 3, parentChunkId: 'P2' });
    const z = chunk('z', 'z.', { ordinal: 3, parentChunkId: 'P1' });
    expect((await packContext([sc(x, 0.9), sc(y, 0.8)], { maxTokens: 100 }, { tokenCounter: words })).text).toBe('[1] x.\n\ny.');
    expect((await packContext([sc(x, 0.9), sc(z, 0.8)], { maxTokens: 100 }, { tokenCounter: words })).text).toBe('[1] x.\n\n[2] z.');
    const other = chunk('o', 'o.', { ordinal: 2, documentId: 'e' });
    expect((await packContext([sc(x, 0.9), sc(other, 0.8)], { maxTokens: 100 }, { tokenCounter: words })).citations.map((c) => c.label)).toEqual(['[1]', '[2]']);
  });

  it('expands to the parent only when the budget allows, via the filtered fetch', async () => {
    const parent = chunk('P', 'leaf one. leaf two. leaf three.', { ordinal: 0 });
    const l1 = chunk('l1', 'leaf one.', { ordinal: 1, parentChunkId: 'P' });
    const l3 = chunk('l3', 'leaf three.', { ordinal: 3, parentChunkId: 'P' });
    const fetchParents = jest.fn(async (ids: string[]) => (ids.includes('P') ? [parent] : []));
    const roomy = await packContext([sc(l1, 0.9), sc(l3, 0.7)], { maxTokens: 100 }, { tokenCounter: words, fetchParents });
    expect(roomy.text).toBe('[1] leaf one. leaf two. leaf three.');
    expect(roomy.citations).toEqual([{ label: '[1]', documentId: 'd', chunkId: 'P', headingPath: [] }]);
    expect(roomy).toMatchObject({ chunksIncluded: 2, chunksDropped: 0 });
    expect(fetchParents).toHaveBeenCalledWith(['P']);
    const tight = await packContext([sc(l1, 0.9), sc(l3, 0.7)], { maxTokens: 6, safetyMarginPercent: 0 }, { tokenCounter: words, fetchParents });
    expect(tight.text).toBe('[1] leaf one.\n\n[2] leaf three.');
    // parent not visible to the principal (fetch returns nothing) or from another document: keep the leaves
    const hidden = await packContext([sc(l1, 0.9)], { maxTokens: 100 }, { tokenCounter: words, fetchParents: async () => [] });
    expect(hidden.text).toBe('[1] leaf one.');
    const foreign = await packContext([sc(l1, 0.9)], { maxTokens: 100 }, { tokenCounter: words, fetchParents: async () => [{ ...parent, documentId: 'x' }] });
    expect(foreign.text).toBe('[1] leaf one.');
    expect((await packContext([sc(l1, 0.9)], { maxTokens: 100 }, { tokenCounter: words })).text).toBe('[1] leaf one.');
  });

  it('orders the strongest blocks at the start and end', async () => {
    expect(edgeOrder([1, 2, 3, 4, 5])).toEqual([1, 3, 5, 4, 2]);
    const cands = [0.9, 0.8, 0.7, 0.6].map((s, i) => sc(chunk(`c${i}`, `s${s}`, { ordinal: i * 10 }), s));
    const ctx = await packContext(cands, { maxTokens: 1000 }, { tokenCounter: words });
    expect(ctx.text).toBe('[1] s0.9\n\n[2] s0.7\n\n[3] s0.6\n\n[4] s0.8');
  });
});

describe('knowledge retriever end to end', () => {
  it('ingests, retrieves with small-to-big expansion and cites the source', async () => {
    const store = memoryVectorStore();
    const r = rag(store);
    const body = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} explains sick leave rule number ${i} in detail.`).join('\n\n');
    await r.ingest(src(`# Leave\n\n## Sick\n\n${body}\n\n## Annual\n\nAnnual leave is twenty days.`));
    const ctx = await r.getContext({ text: 'sick leave rule', filter: { tenantId: 'acme', aclGroups: ['hr'] }, topK: 3 }, { maxTokens: 4000 });
    expect(ctx.text).toMatch(/^\[1\] Leave > Sick/);
    expect(ctx.citations[0]).toMatchObject({ label: '[1]', documentId: 'doc1', headingPath: ['Leave', 'Sick'] });
    expect(ctx.tokensUsed).toBeLessThanOrEqual(3800);
    expect(ctx.chunksIncluded).toBeGreaterThan(0);
    // the parent replaced its leaves: more paragraphs are shown than leaves were retrieved
    expect((ctx.text.match(/Paragraph \d/g) ?? []).length).toBeGreaterThan(3);
    const tiny = await r.getContext({ text: 'sick leave rule', filter: { tenantId: 'acme', aclGroups: ['hr'] }, topK: 3 }, { maxTokens: 30 });
    expect(tiny.tokensUsed).toBeLessThanOrEqual(28);
    expect(tiny.chunksDropped).toBeGreaterThan(0);
  });

  it('rejects a bad budget before embedding', async () => {
    const emb = fakeEmbeddings();
    const k = createKnowledgeRetriever({ collection: 'kb', embeddings: emb, vectorStore: memoryVectorStore() });
    await expect(k.getContext({ text: 'q', filter: { tenantId: 't', aclGroups: [] } }, { maxTokens: -1 })).rejects.toThrow(/maxTokens/);
    expect(emb.calls).toBe(0);
  });
});
