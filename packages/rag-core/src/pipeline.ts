import { createHash } from 'crypto';
import { cleanerChain, duplicateBlockCleaner, whitespaceUnicodeCleaner } from './cleaners';
import { structureChunker } from './chunker';
import {
  ChunkingOptions, Chunker, ChunkRecord, ContentCleaner, DocumentChunk, DocumentExtractor, DocumentSource,
  EmbeddingModel, IngestionPipeline, IngestionResult, TokenCounter, VectorStore,
} from './models';
import { renderMarkdown } from './render';
import { exactTokenCounter } from './tokenizer';

export interface IngestionPipelineOptions {
  collection: string;
  extractors: DocumentExtractor[];
  embeddings: EmbeddingModel;
  vectorStore: VectorStore;
  chunking: ChunkingOptions;
  tokenCounter?: TokenCounter;
  cleaners?: ContentCleaner[];
  chunker?: Chunker;
  embedBatchSize?: number;
}

const EMPTY = new Float32Array(0);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sameSet = (a: readonly string[], b: readonly string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};

function assertSource(s: DocumentSource): void {
  if (!s || typeof s.documentId !== 'string' || !s.documentId) throw new Error('source.documentId is required');
  if (typeof s.tenantId !== 'string' || !s.tenantId) throw new Error('source.tenantId is required');
  if (!Array.isArray(s.aclGroups)) throw new Error('source.aclGroups is required (use [] for no groups)');
  if (!Number.isInteger(s.documentVersion)) throw new Error('source.documentVersion must be an integer');
}

/**
 * Extract → clean → chunk → embed (reusing known vectors) → upsert, with incremental behaviour
 * (spec §8.4): unchanged documents are skipped, older versions are reported `stale`, vanished
 * chunks are deleted, and ACL / embedding-model / chunking changes force a re-index.
 */
export function createIngestionPipeline(options: IngestionPipelineOptions): IngestionPipeline {
  const counter = options.tokenCounter ?? exactTokenCounter();
  const chunker = options.chunker ?? structureChunker({ tokenCounter: counter });
  const cleaner = cleanerChain(options.cleaners ?? [whitespaceUnicodeCleaner(), duplicateBlockCleaner()]);
  const { collection, embeddings, vectorStore, chunking } = options;
  const batch = options.embedBatchSize ?? 64;
  const pipelineSig = sha(JSON.stringify([chunking, embeddings.modelId]));

  let ready: Promise<void> | undefined;
  const ensure = (signal?: AbortSignal) => {
    ready ??= vectorStore
      .ensureCollection({ name: collection, dimensions: embeddings.dimensions, modelId: embeddings.modelId }, signal)
      .catch((e) => {
        ready = undefined;
        throw e;
      });
    return ready;
  };

  // Serialise work per (tenant, document) within this process so last-writer-wins by version holds.
  const tails = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
  const key = (tenantId: string, documentId: string) => JSON.stringify([tenantId, documentId]);

  async function embedAll(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += batch) {
      signal?.throwIfAborted();
      const part = texts.slice(i, i + batch);
      const vecs = await embeddings.embed(part, signal);
      if (vecs.length !== part.length) throw new Error(`embedding model returned ${vecs.length} vectors for ${part.length} texts`);
      for (const v of vecs) {
        if (v.length !== embeddings.dimensions) throw new Error(`embedding has ${v.length} dimensions, expected ${embeddings.dimensions}`);
      }
      out.push(...vecs);
    }
    return out;
  }

  async function doIngest(source: DocumentSource, signal?: AbortSignal): Promise<IngestionResult> {
    await ensure(signal);
    const extractor = options.extractors.find((e) => e.canExtract(source.contentType, source.fileName));
    if (!extractor) throw new Error(`no extractor for content type "${source.contentType}"`);

    const base = { documentId: source.documentId, rawTokens: 0, cleanTokens: 0, chunkCount: 0, chunksEmbedded: 0, chunksReused: 0 };
    const existing = await vectorStore.listDocument(collection, { tenantId: source.tenantId, documentId: source.documentId }, signal);
    const existingVersion = existing.reduce((m, r) => Math.max(m, r.documentVersion), -Infinity);
    if (existing.length && source.documentVersion < existingVersion) return { ...base, outcome: 'stale' };

    signal?.throwIfAborted();
    const extracted = await extractor.extract(source, { tokenCounter: counter }, signal);
    base.rawTokens = extracted.stats.rawTokens;

    const unchanged =
      existing.length > 0 &&
      existing.every(
        (r) =>
          r.metadata?.documentHash === extracted.contentHash &&
          r.metadata?.pipelineSig === pipelineSig &&
          r.modelId === embeddings.modelId &&
          sameSet(r.aclGroups, source.aclGroups),
      );
    if (unchanged) {
      const leaves = existing.filter((r) => r.metadata?.role === 'leaf').length;
      return { ...base, outcome: 'unchanged', chunkCount: leaves };
    }

    const cleaned = await cleaner.clean(extracted, signal);
    base.cleanTokens = counter.count(renderMarkdown(cleaned.elements, counter));

    const meta = { ...source.metadata, contentType: source.contentType, documentHash: extracted.contentHash, pipelineSig };
    const chunks: DocumentChunk[] = [];
    for await (const c of chunker.chunk(cleaned, chunking, signal)) chunks.push({ ...c, metadata: { ...meta, ...c.metadata } });
    const leaves = chunks.filter((c) => c.metadata?.role === 'leaf');

    // Reuse vectors already in the store for the same (model, content hash); embed the rest once each.
    const hashes = [...new Set(leaves.map((c) => c.contentHash))];
    const known = hashes.length ? await vectorStore.findByContentHash(collection, hashes, embeddings.modelId, signal) : new Map<string, Float32Array>();
    const toEmbed = hashes.filter((h) => !known.has(h));
    const vectors = await embedAll(toEmbed.map((h) => (leaves.find((c) => c.contentHash === h) as DocumentChunk).text), signal);
    const byHash = new Map(known);
    toEmbed.forEach((h, i) => byHash.set(h, vectors[i]));

    const records: ChunkRecord[] = chunks.map((chunk) => ({
      chunk,
      vector: chunk.metadata?.role === 'parent' ? EMPTY : (byHash.get(chunk.contentHash) as Float32Array),
      modelId: embeddings.modelId,
      tenantId: source.tenantId,
      aclGroups: [...source.aclGroups],
      documentVersion: source.documentVersion,
    }));

    signal?.throwIfAborted();
    if (records.length) await vectorStore.upsert(collection, records, signal);
    const keep = new Set(chunks.map((c) => c.chunkId));
    const vanished = existing.map((r) => r.chunkId).filter((id) => !keep.has(id));
    if (vanished.length) {
      await vectorStore.delete(collection, { tenantId: source.tenantId, documentId: source.documentId, chunkIds: vanished }, signal);
    }

    return {
      ...base,
      outcome: existing.length ? 'updated' : 'indexed',
      chunkCount: leaves.length,
      chunksEmbedded: leaves.filter((c) => !known.has(c.contentHash)).length,
      chunksReused: leaves.filter((c) => known.has(c.contentHash)).length,
    };
  }

  return {
    ingest(source, signal) {
      assertSource(source);
      return serial(key(source.tenantId, source.documentId), () => doIngest(source, signal));
    },
    deleteDocument(documentId, tenantId, signal) {
      if (!documentId) return Promise.reject(new Error('documentId is required'));
      if (!tenantId) return Promise.reject(new Error('tenantId is required'));
      return serial(key(tenantId, documentId), async () => {
        await ensure(signal);
        await vectorStore.delete(collection, { tenantId, documentId }, signal);
      });
    },
  };
}
