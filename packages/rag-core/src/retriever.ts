import { EmbeddingModel, RetrievalFilter, RetrievalQuery, ScoredChunk, VectorStore } from './models';

export interface RetrieverOptions {
  collection: string;
  embeddings: EmbeddingModel;
  vectorStore: VectorStore;
  /** Called once per retriever when a requested mode has to degrade (e.g. hybrid → vector). Default console.warn. */
  warn?: (message: string) => void;
}

export interface Retriever {
  retrieve(query: RetrievalQuery, signal?: AbortSignal): Promise<{ candidates: ScoredChunk[]; candidatesConsidered: number }>;
}

export const DEFAULT_TOP_K = 20;
export const DEFAULT_MMR = { enabled: true, lambda: 0.7 } as const;
/** MMR re-ranks at most this many candidates (spec §8.5). */
export const MMR_CANDIDATE_CAP = 50;

/** Throws unless the filter names a tenant and an ACL group list. Never optional (spec §6.4, §10). */
export function assertRetrievalFilter(filter: RetrievalFilter | undefined): asserts filter is RetrievalFilter {
  if (!filter || typeof filter.tenantId !== 'string' || !filter.tenantId.trim()) {
    throw new Error('retrieval requires filter.tenantId');
  }
  if (!Array.isArray(filter.aclGroups) || filter.aclGroups.some((g) => typeof g !== 'string')) {
    throw new Error('retrieval requires filter.aclGroups (string array; [] matches nothing)');
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Maximal marginal relevance: greedily picks `k` items maximising
 * `lambda * relevance − (1 − lambda) * max similarity to already picked`. Items without a vector
 * are treated as dissimilar to everything.
 */
export function mmr(candidates: ScoredChunk[], k: number, lambda: number): ScoredChunk[] {
  const pool = [...candidates];
  const picked: ScoredChunk[] = [];
  while (picked.length < k && pool.length) {
    let best = 0;
    let bestValue = -Infinity;
    pool.forEach((c, i) => {
      let maxSim = 0;
      for (const p of picked) {
        if (c.vector && p.vector) maxSim = Math.max(maxSim, cosineSimilarity(c.vector, p.vector));
      }
      const value = lambda * c.score - (1 - lambda) * maxSim;
      if (value > bestValue) {
        bestValue = value;
        best = i;
      }
    });
    picked.push(pool.splice(best, 1)[0]);
  }
  return picked;
}

/** Embeds the query and searches the store with the mandatory security filter, then applies MMR. */
export function createRetriever(options: RetrieverOptions): Retriever {
  const { collection, embeddings, vectorStore } = options;
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const warned = new Set<string>();
  const warnOnce = (m: string) => {
    if (!warned.has(m)) {
      warned.add(m);
      warn(m);
    }
  };

  return {
    async retrieve(query, signal) {
      if (!query || typeof query.text !== 'string' || !query.text.trim()) throw new Error('query.text is required');
      assertRetrievalFilter(query.filter);
      const topK = query.topK ?? DEFAULT_TOP_K;
      if (!Number.isInteger(topK) || topK < 1) throw new Error('query.topK must be a positive integer');
      const mmrOpts = query.mmr ?? DEFAULT_MMR;
      if (mmrOpts.enabled && !(mmrOpts.lambda >= 0 && mmrOpts.lambda <= 1)) throw new Error('query.mmr.lambda must be in [0, 1]');

      let mode = query.mode ?? 'hybrid';
      if (mode === 'graph-local' || mode === 'graph-global' || mode === 'mix') {
        throw new Error(`retrieval mode "${mode}" needs GraphRAG, which is not available yet`);
      }
      if (mode === 'keyword' && !vectorStore.capabilities.keyword) throw new Error('vector store does not support keyword search');
      if (mode === 'hybrid' && !vectorStore.capabilities.hybrid) {
        warnOnce('vector store does not support hybrid search; degrading to vector-only');
        mode = 'vector';
      }

      signal?.throwIfAborted();
      let vector: Float32Array | undefined;
      if (mode !== 'keyword') {
        [vector] = await embeddings.embed([query.text], signal);
        if (!vector || vector.length !== embeddings.dimensions) throw new Error('embedding model returned an invalid query vector');
      }

      const useMmr = mmrOpts.enabled && vectorStore.capabilities.returnsVectors;
      const fetchK = useMmr ? Math.max(topK, Math.min(MMR_CANDIDATE_CAP, topK * 3)) : topK;
      const hits = await vectorStore.search(
        collection,
        { filter: { tenantId: query.filter.tenantId, aclGroups: [...query.filter.aclGroups] }, vector, text: query.text, topK: fetchK, minScore: query.minScore, mode },
        signal,
      );
      // Defence in depth for adapters that ignore minScore.
      const kept = query.minScore === undefined ? hits : hits.filter((h) => h.score >= (query.minScore as number));
      const candidates = useMmr ? mmr(kept, topK, mmrOpts.lambda) : kept.slice(0, topK);
      return { candidates, candidatesConsidered: kept.length };
    },
  };
}
