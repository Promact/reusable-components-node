import { createLocalEmbeddings, FeatureExtractor, PipelineLoader } from './index';

const pipelineMock = jest.fn();
jest.mock('@huggingface/transformers', () => ({ pipeline: (...a: unknown[]) => pipelineMock(...a) }));

/** Fake extractor: vector = [len, 0, 0, ...] unnormalised unless told otherwise. */
function fakeLoader(dims = 4, scale = 1) {
  const extractor = jest.fn(async (texts: string[]) => {
    const data = new Float32Array(texts.length * dims);
    texts.forEach((t, i) => { data[i * dims] = t.length * scale; });
    return { data, dims: [texts.length, dims] };
  });
  const loader = jest.fn(async () => extractor as unknown as FeatureExtractor) as unknown as jest.MockedFunction<PipelineLoader>;
  return { extractor, loader };
}

describe('createLocalEmbeddings', () => {
  it('is lazy: nothing loads until embed, and the pipeline loads once', async () => {
    const { loader, extractor } = fakeLoader();
    const m = createLocalEmbeddings({ dimensions: 4, batchSize: 2, loadPipeline: loader });
    expect(loader).not.toHaveBeenCalled();
    expect(m.modelId).toBe('local:Xenova/all-MiniLM-L6-v2');
    const out = await m.embed(['a', 'bb', 'ccc']);
    await m.embed(['d']);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(extractor).toHaveBeenCalledTimes(3);
    expect(extractor.mock.calls[0]).toEqual([['a', 'bb'], { pooling: 'mean', normalize: true }]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeInstanceOf(Float32Array);
  });

  it('returns unit-length vectors even if the pipeline did not normalise', async () => {
    const { loader } = fakeLoader(4, 3);
    const m = createLocalEmbeddings({ dimensions: 4, loadPipeline: loader });
    const [v] = await m.embed(['abcd']);
    expect(Math.hypot(...Array.from(v))).toBeCloseTo(1, 5);
    expect(v[0]).toBeCloseTo(1, 5);
  });

  it('leaves zero vectors and already-normalised vectors alone', async () => {
    const zero = jest.fn(async () => ({ data: new Float32Array(4), dims: [1, 4] }));
    const m = createLocalEmbeddings({ dimensions: 4, loadPipeline: async () => zero as unknown as FeatureExtractor });
    expect(Array.from((await m.embed(['x']))[0])).toEqual([0, 0, 0, 0]);
    const unit = jest.fn(async () => ({ data: [0, 1, 0, 0], dims: [1, 4] }));
    const m2 = createLocalEmbeddings({ dimensions: 4, loadPipeline: async () => unit as unknown as FeatureExtractor });
    expect(Array.from((await m2.embed(['x']))[0])).toEqual([0, 1, 0, 0]);
  });

  it('returns [] without loading the model', async () => {
    const { loader } = fakeLoader();
    expect(await createLocalEmbeddings({ dimensions: 4, loadPipeline: loader }).embed([])).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
  });

  it('retries loading after a failure', async () => {
    const { extractor } = fakeLoader();
    const loader = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(extractor);
    const m = createLocalEmbeddings({ dimensions: 4, loadPipeline: loader });
    await expect(m.embed(['x'])).rejects.toThrow('offline');
    await expect(m.embed(['x'])).resolves.toHaveLength(1);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('rejects a model whose output shape differs from the configuration', async () => {
    const { loader } = fakeLoader(8);
    const m = createLocalEmbeddings({ dimensions: 4, loadPipeline: loader });
    await expect(m.embed(['x'])).rejects.toThrow(/expected 1x4, model returned 1x8/);
  });

  it('honours an aborted signal', async () => {
    const { loader, extractor } = fakeLoader();
    const m = createLocalEmbeddings({ dimensions: 4, loadPipeline: loader });
    const ctl = new AbortController();
    ctl.abort();
    await expect(m.embed(['x'], ctl.signal)).rejects.toThrow();
    expect(extractor).not.toHaveBeenCalled();
  });

  it('passes dtype and cacheDir to the loader', async () => {
    const { loader } = fakeLoader();
    await createLocalEmbeddings({ dimensions: 4, dtype: 'q8', cacheDir: '/tmp/m', model: 'org/custom', loadPipeline: loader }).embed(['x']);
    expect(loader).toHaveBeenCalledWith('org/custom', { dtype: 'q8', cache_dir: '/tmp/m' });
  });

  it('default loader lazily imports transformers.js (mocked, no download)', async () => {
    const extractor = jest.fn(async () => ({ data: new Float32Array(384).fill(1), dims: [1, 384] }));
    pipelineMock.mockResolvedValue(extractor);
    const m = createLocalEmbeddings();
    expect(m.dimensions).toBe(384);
    expect(pipelineMock).not.toHaveBeenCalled();
    const [v] = await m.embed(['hi']);
    expect(v).toHaveLength(384);
    expect(pipelineMock).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {});
  });

  it('default loader hands cacheDir to transformers.js under its own option name (cache_dir)', async () => {
    pipelineMock.mockResolvedValue(jest.fn(async () => ({ data: new Float32Array(384).fill(1), dims: [1, 384] })));
    await createLocalEmbeddings({ cacheDir: '/models' }).embed(['hi']);
    expect(pipelineMock).toHaveBeenLastCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { cache_dir: '/models' });
  });

  it('validates options eagerly', () => {
    expect(() => createLocalEmbeddings({ model: ' ' })).toThrow(/model/);
    expect(() => createLocalEmbeddings({ model: 'org/other' })).toThrow(/dimensions is required/);
    expect(() => createLocalEmbeddings({ dimensions: 0 })).toThrow(/dimensions/);
    expect(() => createLocalEmbeddings({ batchSize: 0 })).toThrow(/batchSize/);
    expect(() => createLocalEmbeddings({ model: 'Xenova/all-MiniLM-L6-v2' })).not.toThrow();
  });
});
