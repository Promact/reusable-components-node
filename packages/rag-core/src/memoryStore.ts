import { ChunkRecord, CollectionDefinition, RecordFilter, ScoredChunk, SearchRequest, VectorStore } from './models';

interface Collection {
  def: CollectionDefinition;
  /** Keyed by (tenantId, chunkId): chunk ids are only unique within a tenant (two tenants may share a documentId). */
  records: Map<string, ChunkRecord>;
}

const recordKey = (tenantId: string, chunkId: string): string => `${tenantId}\u0000${chunkId}`;

/** Parent chunks (small-to-big) are stored for expansion but never embedded or ranked. */
const isParent = (r: ChunkRecord): boolean => r.chunk.metadata?.role === 'parent';

const tokens = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function keywordScore(query: string, text: string): number {
  const q = new Set(tokens(query));
  if (q.size === 0) return 0;
  const t = new Set(tokens(text));
  let hit = 0;
  for (const w of q) if (t.has(w)) hit++;
  return hit / q.size;
}

/** In-memory reference store for tests and small deployments. Applies tenant/ACL filters inside search. */
export function memoryVectorStore(): VectorStore {
  const collections = new Map<string, Collection>();
  const get = (name: string): Collection => {
    const c = collections.get(name);
    if (!c) throw new Error(`collection "${name}" does not exist; call ensureCollection first`);
    return c;
  };

  return {
    capabilities: { hybrid: true, keyword: true, returnsVectors: true },

    async ensureCollection(def) {
      const existing = collections.get(def.name);
      if (!existing) {
        collections.set(def.name, { def, records: new Map() });
        return;
      }
      if (existing.def.dimensions !== def.dimensions || existing.def.modelId !== def.modelId) {
        throw new Error(
          `collection "${def.name}" exists with model ${existing.def.modelId}/${existing.def.dimensions}d; use a new collection for ${def.modelId}/${def.dimensions}d`,
        );
      }
    },

    async upsert(collection, records) {
      const c = get(collection);
      for (const r of records) {
        if (!r.tenantId) throw new Error('record without tenantId');
        if (!isParent(r) && r.vector.length !== c.def.dimensions) {
          throw new Error(`vector has ${r.vector.length} dimensions, collection expects ${c.def.dimensions}`);
        }
        c.records.set(recordKey(r.tenantId, r.chunk.chunkId), r);
      }
    },

    async delete(collection, filter: RecordFilter) {
      if (!filter.tenantId) throw new Error('delete requires tenantId');
      const c = get(collection);
      const ids = filter.chunkIds ? new Set(filter.chunkIds) : undefined;
      for (const [key, r] of c.records) {
        if (r.tenantId !== filter.tenantId) continue;
        if (filter.documentId !== undefined && r.chunk.documentId !== filter.documentId) continue;
        if (ids && !ids.has(r.chunk.chunkId)) continue;
        c.records.delete(key);
      }
    },

    async findByContentHash(collection, hashes, modelId) {
      const wanted = new Set(hashes);
      const out = new Map<string, Float32Array>();
      for (const r of get(collection).records.values()) {
        if (!isParent(r) && r.modelId === modelId && wanted.has(r.chunk.contentHash)) {
          out.set(r.chunk.contentHash, r.vector);
        }
      }
      return out;
    },

    async listDocument(collection, filter) {
      return [...get(collection).records.values()]
        .filter((r) => r.tenantId === filter.tenantId && r.chunk.documentId === filter.documentId)
        .map((r) => ({
          chunkId: r.chunk.chunkId,
          contentHash: r.chunk.contentHash,
          modelId: r.modelId,
          documentVersion: r.documentVersion,
          aclGroups: r.aclGroups,
          metadata: r.chunk.metadata,
        }));
    },

    async search(collection, request: SearchRequest) {
      const { filter } = request;
      if (!filter || !filter.tenantId || !Array.isArray(filter.aclGroups)) {
        throw new Error('search requires a RetrievalFilter with tenantId and aclGroups');
      }
      const allowed = new Set(filter.aclGroups);
      const scored: ScoredChunk[] = [];
      for (const r of get(collection).records.values()) {
        // security filter first: tenant AND at least one shared ACL group
        if (r.tenantId !== filter.tenantId || !r.aclGroups.some((g) => allowed.has(g))) continue;
        if (isParent(r)) continue; // parents are fetched by id for expansion, never ranked
        const vec = request.vector ? cosine(request.vector, r.vector) : 0;
        const kw = request.text ? keywordScore(request.text, r.chunk.text) : 0;
        let score: number;
        if (request.mode === 'vector') score = vec;
        else if (request.mode === 'keyword') score = kw;
        else score = (vec + kw) / 2;
        if (request.mode === 'keyword' && score === 0) continue; // a text index only returns matches
        if (request.minScore !== undefined && score < request.minScore) continue;
        scored.push({ chunk: r.chunk, score, vector: r.vector });
      }
      return scored.sort((a, b) => b.score - a.score || a.chunk.chunkId.localeCompare(b.chunk.chunkId)).slice(0, request.topK);
    },
  };
}
