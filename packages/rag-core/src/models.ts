// Models and provider interfaces — spec §6.1–6.4.

export interface DocumentSource {
  documentId: string;
  content: Buffer | NodeJS.ReadableStream;
  contentType: string;
  fileName?: string;
  documentVersion: number;
  tenantId: string;
  aclGroups: readonly string[];
  metadata?: Readonly<Record<string, string>>;
}

export type DocumentElement =
  | { kind: 'heading'; level: number; text: string; page?: number }
  | { kind: 'paragraph'; text: string; page?: number }
  | { kind: 'list'; items: string[]; ordered: boolean; page?: number }
  | { kind: 'table'; header: string[]; rows: string[][]; page?: number }
  | { kind: 'code'; text: string; language?: string; page?: number }
  | { kind: 'image'; caption?: string; page?: number };

export interface ExtractionStats {
  rawChars: number;
  rawTokens: number;
  pages?: number;
  elementsDropped: number;
  pagesNeedingOcr: number[];
}

export interface CleaningStep {
  cleaner: string;
  charsRemoved: number;
  elementsRemoved: number;
}

/** What the cleaner chain removed; steps are in execution order. */
export interface CleaningStats {
  charsRemoved: number;
  elementsRemoved: number;
  steps: CleaningStep[];
}

export interface ExtractedDocument {
  documentId: string;
  contentHash: string;
  elements: DocumentElement[];
  stats: ExtractionStats;
  cleaning?: CleaningStats;
}

export interface ExtractionOptions {
  tokenCounter?: TokenCounter;
}

export interface ChunkingOptions {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

export interface DocumentExtractor {
  canExtract(contentType: string, fileName?: string): boolean;
  extract(source: DocumentSource, options: ExtractionOptions, signal?: AbortSignal): Promise<ExtractedDocument>;
}

export interface ContentCleaner {
  clean(doc: ExtractedDocument, signal?: AbortSignal): Promise<ExtractedDocument>;
}

export interface DocumentChunk {
  chunkId: string;
  documentId: string;
  ordinal: number;
  text: string;
  tokenCount: number;
  headingPath: string[];
  parentChunkId?: string;
  pageStart?: number;
  pageEnd?: number;
  contentHash: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface Chunker {
  chunk(doc: ExtractedDocument, options: ChunkingOptions, signal?: AbortSignal): AsyncIterable<DocumentChunk>;
}

export interface IngestionResult {
  documentId: string;
  outcome: 'indexed' | 'unchanged' | 'updated' | 'stale' | 'failed';
  rawTokens: number;
  cleanTokens: number;
  chunkCount: number;
  chunksEmbedded: number;
  chunksReused: number;
  graph?: { entitiesAdded: number; relationsAdded: number; llmTokensUsed: number };
}

export interface IngestionPipeline {
  ingest(source: DocumentSource, signal?: AbortSignal): Promise<IngestionResult>;
  deleteDocument(documentId: string, tenantId: string, signal?: AbortSignal): Promise<void>;
}

export interface EmbeddingModel {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface TokenCounter {
  count(text: string): number;
}

/** Mandatory security filter; adapters must apply it inside the database query. */
export interface RetrievalFilter {
  tenantId: string;
  aclGroups: readonly string[];
}

export interface CollectionDefinition {
  name: string;
  dimensions: number;
  modelId: string;
}

export interface ChunkRecord {
  chunk: DocumentChunk;
  vector: Float32Array;
  modelId: string;
  tenantId: string;
  aclGroups: readonly string[];
  documentVersion: number;
}

export interface RecordFilter {
  tenantId: string;
  documentId?: string;
  chunkIds?: string[];
}

export interface SearchRequest {
  filter: RetrievalFilter; // required: there is no overload without it
  vector?: Float32Array;
  text?: string;
  topK: number;
  minScore?: number;
  mode: 'vector' | 'keyword' | 'hybrid';
}

export interface ScoredChunk {
  chunk: DocumentChunk;
  score: number;
  vector?: Float32Array;
}

/** Lightweight view of a stored chunk, used by incremental ingestion (no vectors). */
export interface ChunkRef {
  chunkId: string;
  contentHash: string;
  modelId: string;
  documentVersion: number;
  aclGroups: readonly string[];
  metadata?: Readonly<Record<string, string>>;
}

/**
 * Adapters must treat `(tenantId, chunkId)` as the record identity: chunk ids are derived from
 * `documentId` (§6.2), which is only unique within a tenant, so keying on `chunkId` alone lets one
 * tenant overwrite another tenant's records.
 */
export interface VectorStore {
  readonly capabilities: { hybrid: boolean; keyword: boolean; returnsVectors: boolean };
  ensureCollection(def: CollectionDefinition, signal?: AbortSignal): Promise<void>;
  upsert(collection: string, records: ChunkRecord[], signal?: AbortSignal): Promise<void>;
  delete(collection: string, filter: RecordFilter, signal?: AbortSignal): Promise<void>;
  findByContentHash(
    collection: string,
    hashes: string[],
    modelId: string,
    signal?: AbortSignal,
  ): Promise<Map<string, Float32Array>>;
  search(collection: string, request: SearchRequest, signal?: AbortSignal): Promise<ScoredChunk[]>;
  /**
   * Lists the chunks stored for one document of one tenant. Not in the spec §6.3 sketch, but
   * incremental ingestion (§8.4: doc-hash skip, vanished-chunk deletion, version check) cannot
   * work without it. Must filter by tenantId inside the query.
   */
  listDocument(collection: string, filter: { tenantId: string; documentId: string }, signal?: AbortSignal): Promise<ChunkRef[]>;
}

export interface ChatModel {
  readonly modelId: string;
  completeJson<T>(
    request: { system: string; user: string; schema: object; maxTokens: number },
    signal?: AbortSignal,
  ): Promise<{ value: T; usage: { inputTokens: number; outputTokens: number } }>;
}

export interface RetrievalQuery {
  text: string;
  filter: RetrievalFilter;
  topK?: number;
  minScore?: number;
  mode?: 'vector' | 'keyword' | 'hybrid' | 'graph-local' | 'graph-global' | 'mix';
  mmr?: { enabled: boolean; lambda: number };
}

export interface ContextBudget {
  maxTokens: number;
  safetyMarginPercent?: number;
  format?: 'markdown';
}

export interface Citation {
  label: string; // "[1]" or "[G1]"
  documentId: string;
  chunkId?: string;
  page?: number;
  headingPath?: string[];
}

export interface RetrievedContext {
  text: string;
  citations: Citation[];
  tokensUsed: number;
  candidatesConsidered: number;
  chunksIncluded: number;
  chunksDropped: number;
  graphFactsIncluded: number;
}

export interface KnowledgeRetriever {
  getContext(query: RetrievalQuery, budget: ContextBudget, signal?: AbortSignal): Promise<RetrievedContext>;
}
