import {
  ChatModel,
  ChunkingOptions,
  DocumentExtractor,
  DocumentSource,
  EmbeddingModel,
  IngestionResult,
  KnowledgeRetriever,
  VectorStore,
} from './models';
import { createKnowledgeRetriever } from './packer';
import { createIngestionPipeline } from './pipeline';
import { tokenCounterFor } from './tokenizer';

export interface RagOptions {
  collection: string;
  chunking: ChunkingOptions;
  tokenizer?: 'o200k_base' | 'cl100k_base' | 'approximate';
  extractors: DocumentExtractor[];
  /** Content types the deployment promises to ingest; each needs a matching extractor. */
  contentTypes?: string[];
  embeddings: EmbeddingModel;
  vectorStore: VectorStore;
  graph?: { chat?: ChatModel };
}

export interface Rag extends KnowledgeRetriever {
  readonly options: Readonly<RagOptions>;
  ingest(source: DocumentSource, signal?: AbortSignal): Promise<IngestionResult>;
  deleteDocument(documentId: string, tenantId: string, signal?: AbortSignal): Promise<void>;
}

const TOKENIZERS = ['o200k_base', 'cl100k_base', 'approximate'];

export class RagConfigError extends Error {
  constructor(message: string) {
    super(`Invalid RAG configuration: ${message}`);
    this.name = 'RagConfigError';
  }
}

function positiveInt(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export function validateRagOptions(options: RagOptions): void {
  if (!options || typeof options !== 'object') throw new RagConfigError('options are required');
  if (typeof options.collection !== 'string' || options.collection.trim() === '') {
    throw new RagConfigError('collection must be a non-empty string');
  }
  const c = options.chunking;
  if (!c || !positiveInt(c.targetTokens) || !positiveInt(c.maxTokens)) {
    throw new RagConfigError('chunking.targetTokens and chunking.maxTokens must be positive integers');
  }
  if (c.targetTokens > c.maxTokens) throw new RagConfigError('chunking.targetTokens must be <= maxTokens');
  if (!Number.isInteger(c.overlapTokens) || c.overlapTokens < 0 || c.overlapTokens >= c.targetTokens) {
    throw new RagConfigError('chunking.overlapTokens must be an integer >= 0 and < targetTokens');
  }
  if (options.tokenizer !== undefined && !TOKENIZERS.includes(options.tokenizer)) {
    throw new RagConfigError(`tokenizer must be one of ${TOKENIZERS.join(', ')}`);
  }
  if (!Array.isArray(options.extractors)) throw new RagConfigError('extractors must be an array');
  for (const type of options.contentTypes ?? []) {
    if (!options.extractors.some((e) => e.canExtract(type))) {
      throw new RagConfigError(`no extractor can handle declared content type "${type}"`);
    }
  }
  const e = options.embeddings;
  if (!e || !e.modelId || !positiveInt(e.dimensions)) {
    throw new RagConfigError('embeddings must have a modelId and positive integer dimensions');
  }
  if (!options.vectorStore) throw new RagConfigError('vectorStore is required');
  if (options.graph && !options.graph.chat) throw new RagConfigError('graph mode requires a chat model');
}

/** Validates eagerly and throws on bad config. */
export function createRag(options: RagOptions): Rag {
  validateRagOptions(options);
  const counter = tokenCounterFor(options.tokenizer);
  const pipeline = createIngestionPipeline({
    collection: options.collection,
    extractors: options.extractors,
    embeddings: options.embeddings,
    vectorStore: options.vectorStore,
    chunking: options.chunking,
    tokenCounter: counter,
  });
  const retriever = createKnowledgeRetriever({
    collection: options.collection,
    embeddings: options.embeddings,
    vectorStore: options.vectorStore,
    tokenCounter: counter,
  });
  return {
    options,
    ingest: (source, signal) => pipeline.ingest(source, signal),
    deleteDocument: (id, tenant, signal) => pipeline.deleteDocument(id, tenant, signal),
    getContext: (query, budget, signal) => retriever.getContext(query, budget, signal),
  };
}
