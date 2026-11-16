import { EmbeddingModel } from './models';

export interface OllamaEmbeddingOptions {
  /** Ollama model name, e.g. `nomic-embed-text`. */
  model: string;
  /** Vector size the model returns (must match; checked on every response). */
  dimensions: number;
  /** Server base URL. Default `http://localhost:11434`. */
  url?: string;
  /** Texts per request. Default 64. */
  batchSize?: number;
  /** Extra request headers (e.g. a reverse-proxy token). */
  headers?: Record<string, string>;
  /** Override `fetch` (tests, custom agents). Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export class OllamaEmbeddingModel implements EmbeddingModel {
  readonly modelId: string;
  readonly dimensions: number;
  private readonly endpoint: string;
  private readonly batchSize: number;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  constructor(options: OllamaEmbeddingOptions) {
    if (!options || typeof options.model !== 'string' || !options.model.trim()) {
      throw new Error('OllamaEmbeddingModel: model is required');
    }
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
      throw new Error('OllamaEmbeddingModel: dimensions must be a positive integer');
    }
    const batchSize = options.batchSize ?? 64;
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new Error('OllamaEmbeddingModel: batchSize must be a positive integer');
    }
    const fetchFn = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!fetchFn) throw new Error('OllamaEmbeddingModel: no fetch implementation available');
    const base = (options.url ?? 'http://localhost:11434').replace(/\/+$/, '');
    try {
      new URL(base);
    } catch {
      throw new Error(`OllamaEmbeddingModel: invalid url "${options.url}"`);
    }
    this.modelId = `ollama:${options.model}`;
    this.dimensions = options.dimensions;
    this.endpoint = `${base}/api/embed`;
    this.batchSize = batchSize;
    this.headers = { 'content-type': 'application/json', ...options.headers };
    this.fetchFn = fetchFn;
    this.model = options.model;
  }

  private readonly model: string;

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ model: this.model, input: batch }),
        signal,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`Ollama embed failed: HTTP ${res.status} ${detail}`.trim());
      }
      const json = (await res.json()) as { embeddings?: number[][] };
      const vectors = json.embeddings;
      if (!Array.isArray(vectors) || vectors.length !== batch.length) {
        throw new Error(`Ollama embed: expected ${batch.length} embeddings in response`);
      }
      for (const v of vectors) {
        if (!Array.isArray(v) || v.length !== this.dimensions) {
          throw new Error(
            `Ollama embed: expected ${this.dimensions} dimensions, got ${Array.isArray(v) ? v.length : 'none'}`,
          );
        }
        out.push(Float32Array.from(v));
      }
    }
    return out;
  }
}

export function createOllamaEmbeddingModel(options: OllamaEmbeddingOptions): EmbeddingModel {
  return new OllamaEmbeddingModel(options);
}
