import type { EmbeddingModel } from '@promact/rag-core';
import type { PretrainedModelOptions } from '@huggingface/transformers';

type Dtype = Extract<PretrainedModelOptions['dtype'], string>;
/** Passed to transformers.js `pipeline()`, so keys use its names (`cache_dir`, not `cacheDir`). */
type LoadOptions = { dtype?: Dtype; cache_dir?: string };

/** Minimal shape of a transformers.js feature-extraction pipeline. */
export type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

export type PipelineLoader = (model: string, options: LoadOptions) => Promise<FeatureExtractor>;

export interface LocalEmbeddingsOptions {
  /**
   * Hugging Face model id with ONNX weights. Default `Xenova/all-MiniLM-L6-v2`
   * (English, 384 dims, Apache-2.0).
   */
  model?: string;
  /** Vector size of `model`. Default 384 (required when you change `model`). */
  dimensions?: number;
  /** Texts per forward pass. Default 16. */
  batchSize?: number;
  /** Weight precision, e.g. `fp32` (default), `q8`. */
  dtype?: Dtype;
  /** Where models are cached on disk. Default: transformers.js default. */
  cacheDir?: string;
  /** Replace the loader (tests, preloaded pipelines). */
  loadPipeline?: PipelineLoader;
}

export const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_LOCAL_DIMENSIONS = 384;

const defaultLoader: PipelineLoader = async (model, options) => {
  // transformers.js ships a CommonJS build; imported lazily so merely importing this
  // package never loads onnxruntime or touches the network.
  const tf = await import('@huggingface/transformers');
  return (await tf.pipeline('feature-extraction', model, options)) as unknown as FeatureExtractor;
};

function normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm > 0 && Math.abs(norm - 1) > 1e-6) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

class LocalEmbeddingModel implements EmbeddingModel {
  private extractor?: Promise<FeatureExtractor>;

  constructor(
    readonly modelId: string,
    readonly dimensions: number,
    private readonly model: string,
    private readonly batchSize: number,
    private readonly loadOptions: LoadOptions,
    private readonly loader: PipelineLoader,
  ) {}

  private load(): Promise<FeatureExtractor> {
    if (!this.extractor) {
      this.extractor = this.loader(this.model, this.loadOptions).catch((e) => {
        this.extractor = undefined; // allow a retry after a failed download
        throw e;
      });
    }
    return this.extractor;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      signal?.throwIfAborted();
      const batch = texts.slice(i, i + this.batchSize);
      const res = await extractor(batch, { pooling: 'mean', normalize: true });
      const [rows, dims] = res.dims;
      if (rows !== batch.length || dims !== this.dimensions) {
        throw new Error(
          `Local embeddings: expected ${batch.length}x${this.dimensions}, model returned ${rows}x${dims}`,
        );
      }
      const data = Float32Array.from(res.data);
      for (let r = 0; r < rows; r++) out.push(normalise(data.slice(r * dims, (r + 1) * dims)));
    }
    return out;
  }
}

/** Creates an offline `EmbeddingModel`. The model loads lazily on the first `embed` call. */
export function createLocalEmbeddings(options: LocalEmbeddingsOptions = {}): EmbeddingModel {
  const model = options.model ?? DEFAULT_LOCAL_MODEL;
  if (typeof model !== 'string' || !model.trim()) throw new Error('rag-embed-local: model must be a non-empty string');
  if (options.model !== undefined && options.model !== DEFAULT_LOCAL_MODEL && options.dimensions === undefined) {
    throw new Error('rag-embed-local: dimensions is required when model is not the default');
  }
  const dimensions = options.dimensions ?? DEFAULT_LOCAL_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error('rag-embed-local: dimensions must be a positive integer');
  const batchSize = options.batchSize ?? 16;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('rag-embed-local: batchSize must be a positive integer');
  const loadOptions: LoadOptions = {};
  if (options.dtype) loadOptions.dtype = options.dtype;
  if (options.cacheDir) loadOptions.cache_dir = options.cacheDir;
  return new LocalEmbeddingModel(`local:${model}`, dimensions, model, batchSize, loadOptions, options.loadPipeline ?? defaultLoader);
}
