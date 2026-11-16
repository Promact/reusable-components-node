import OpenAI, { AzureOpenAI } from 'openai';
import type { EmbeddingModel } from '@promact/rag-core';

/** The only part of the OpenAI client we use (lets tests inject a fake). */
export interface EmbeddingsClient {
  embeddings: {
    create(
      body: {
        model: string;
        input: string[];
        dimensions?: number;
        encoding_format: 'float';
      },
      options?: { signal?: AbortSignal },
    ): Promise<{ data: { index: number; embedding: number[] }[] }>;
  };
}

export interface OpenAiEmbeddingsOptions {
  /** Model name (OpenAI) or the model the Azure deployment serves (used for `modelId`). */
  model: string;
  apiKey?: string;
  /** Request a shortened vector (text-embedding-3-*). Becomes the model's `dimensions`. */
  dimensions?: number;
  /** Vector size when the model isn't one of the known OpenAI models and `dimensions` is unset. */
  nativeDimensions?: number;
  /** Custom base URL (OpenAI-compatible servers). */
  baseURL?: string;
  /** Texts per request. Default 96 (the API allows up to 2048 inputs). */
  batchSize?: number;
  /**
   * Retries for 408/409/429/5xx and connection errors. Default 4. The SDK waits for the
   * server's `Retry-After` / `retry-after-ms` header when present, else exponential backoff.
   */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 60000. */
  timeoutMs?: number;
  /** Use Azure OpenAI. `deployment` defaults to `model`. */
  azure?: { endpoint: string; apiVersion: string; deployment?: string };
  /** Inject a client (tests). */
  client?: EmbeddingsClient;
}

const KNOWN_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

function positiveInt(name: string, v: unknown): void {
  if (!Number.isInteger(v) || (v as number) <= 0) {
    throw new Error(`rag-embed-openai: ${name} must be a positive integer`);
  }
}

class OpenAiEmbeddingModel implements EmbeddingModel {
  constructor(
    readonly modelId: string,
    readonly dimensions: number,
    private readonly model: string,
    private readonly requestDimensions: number | undefined,
    private readonly batchSize: number,
    private readonly client: EmbeddingsClient,
  ) {}

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await this.client.embeddings.create(
        {
          model: this.model,
          input: batch,
          encoding_format: 'float',
          ...(this.requestDimensions ? { dimensions: this.requestDimensions } : {}),
        },
        { signal },
      );
      if (!res.data || res.data.length !== batch.length) {
        throw new Error(`OpenAI embeddings: expected ${batch.length} vectors, got ${res.data?.length ?? 0}`);
      }
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      for (const d of sorted) {
        if (d.embedding.length !== this.dimensions) {
          throw new Error(`OpenAI embeddings: expected ${this.dimensions} dimensions, got ${d.embedding.length}`);
        }
        out.push(Float32Array.from(d.embedding));
      }
    }
    return out;
  }
}

/** Creates an OpenAI / Azure OpenAI `EmbeddingModel`. Validates options eagerly. */
export function createOpenAiEmbeddings(options: OpenAiEmbeddingsOptions): EmbeddingModel {
  if (!options || typeof options.model !== 'string' || !options.model.trim()) {
    throw new Error('rag-embed-openai: model is required');
  }
  const batchSize = options.batchSize ?? 96;
  positiveInt('batchSize', batchSize);
  if (batchSize > 2048) throw new Error('rag-embed-openai: batchSize must be <= 2048');
  if (options.dimensions !== undefined) positiveInt('dimensions', options.dimensions);
  if (options.nativeDimensions !== undefined) positiveInt('nativeDimensions', options.nativeDimensions);
  if (options.maxRetries !== undefined && (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)) {
    throw new Error('rag-embed-openai: maxRetries must be a non-negative integer');
  }
  if (options.timeoutMs !== undefined) positiveInt('timeoutMs', options.timeoutMs);

  const native = KNOWN_DIMENSIONS[options.model] ?? options.nativeDimensions;
  const dimensions = options.dimensions ?? native;
  if (dimensions === undefined) {
    throw new Error(`rag-embed-openai: unknown model "${options.model}"; set dimensions or nativeDimensions`);
  }
  if (options.dimensions !== undefined && options.model === 'text-embedding-ada-002') {
    throw new Error('rag-embed-openai: text-embedding-ada-002 does not support dimensions');
  }
  if (native !== undefined && dimensions > native) {
    throw new Error(`rag-embed-openai: dimensions ${dimensions} exceeds the model's ${native}`);
  }

  let client = options.client;
  if (!client) {
    const common = {
      maxRetries: options.maxRetries ?? 4,
      timeout: options.timeoutMs ?? 60_000,
    };
    if (options.azure) {
      const { endpoint, apiVersion, deployment } = options.azure;
      if (!endpoint || !apiVersion) {
        throw new Error('rag-embed-openai: azure.endpoint and azure.apiVersion are required');
      }
      if (!options.apiKey) throw new Error('rag-embed-openai: apiKey is required');
      client = new AzureOpenAI({
        apiKey: options.apiKey,
        endpoint,
        apiVersion,
        deployment: deployment ?? options.model,
        ...common,
      }) as unknown as EmbeddingsClient;
    } else {
      if (!options.apiKey) throw new Error('rag-embed-openai: apiKey is required');
      client = new OpenAI({
        apiKey: options.apiKey,
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        ...common,
      }) as unknown as EmbeddingsClient;
    }
  }

  const prefix = options.azure ? 'azure-openai' : 'openai';
  return new OpenAiEmbeddingModel(
    `${prefix}:${options.model}${options.dimensions ? `@${options.dimensions}` : ''}`,
    dimensions,
    options.model,
    options.dimensions,
    batchSize,
    client,
  );
}
