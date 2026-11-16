import { createOllamaEmbeddingModel, OllamaEmbeddingModel } from './ollamaEmbeddings';

function okFetch(dims = 3) {
  return jest.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(
      JSON.stringify({ embeddings: body.input.map((t) => Array(dims).fill(t.length)) }),
      { status: 200 },
    );
  });
}

describe('OllamaEmbeddingModel', () => {
  it('posts batches to /api/embed and returns Float32Arrays in order', async () => {
    const f = okFetch();
    const m = createOllamaEmbeddingModel({
      model: 'nomic-embed-text',
      dimensions: 3,
      batchSize: 2,
      url: 'http://host:1/',
      headers: { authorization: 'Bearer x' },
      fetch: f as unknown as typeof fetch,
    });
    expect(m.modelId).toBe('ollama:nomic-embed-text');
    expect(m.dimensions).toBe(3);
    const ctl = new AbortController();
    const out = await m.embed(['a', 'bb', 'ccc'], ctl.signal);
    expect(out.map((v) => v[0])).toEqual([1, 2, 3]);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(f).toHaveBeenCalledTimes(2);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('http://host:1/api/embed');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer x');
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'nomic-embed-text', input: ['a', 'bb'] });
    expect(init?.signal).toBe(ctl.signal);
  });

  it('returns [] for no texts without calling the server', async () => {
    const f = okFetch();
    const m = new OllamaEmbeddingModel({ model: 'm', dimensions: 3, fetch: f as unknown as typeof fetch });
    expect(await m.embed([])).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('uses the global fetch by default', async () => {
    const f = okFetch();
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(f as unknown as typeof fetch);
    const m = createOllamaEmbeddingModel({ model: 'm', dimensions: 3 });
    await m.embed(['x']);
    expect(spy.mock.calls[0][0]).toBe('http://localhost:11434/api/embed');
    spy.mockRestore();
  });

  it('throws on HTTP errors, including the body', async () => {
    const f = jest.fn(async () => new Response('model not found', { status: 404 }));
    const m = createOllamaEmbeddingModel({ model: 'm', dimensions: 3, fetch: f as unknown as typeof fetch });
    await expect(m.embed(['x'])).rejects.toThrow(/HTTP 404 model not found/);
  });

  it('tolerates an unreadable error body', async () => {
    const res = { ok: false, status: 500, text: () => Promise.reject(new Error('x')) };
    const m = createOllamaEmbeddingModel({
      model: 'm',
      dimensions: 3,
      fetch: (async () => res) as unknown as typeof fetch,
    });
    await expect(m.embed(['x'])).rejects.toThrow(/HTTP 500/);
  });

  it('rejects malformed responses and wrong dimensions', async () => {
    const mk = (payload: unknown) =>
      createOllamaEmbeddingModel({
        model: 'm',
        dimensions: 3,
        fetch: (async () => new Response(JSON.stringify(payload))) as unknown as typeof fetch,
      });
    await expect(mk({}).embed(['x'])).rejects.toThrow(/expected 1 embeddings/);
    await expect(mk({ embeddings: [] }).embed(['x'])).rejects.toThrow(/expected 1 embeddings/);
    await expect(mk({ embeddings: [[1, 2]] }).embed(['x'])).rejects.toThrow(/expected 3 dimensions, got 2/);
    await expect(mk({ embeddings: ['no'] }).embed(['x'])).rejects.toThrow(/got none/);
  });

  it('validates options eagerly', () => {
    const f = okFetch() as unknown as typeof fetch;
    expect(() => createOllamaEmbeddingModel(undefined as never)).toThrow(/model is required/);
    expect(() => createOllamaEmbeddingModel({ model: ' ', dimensions: 3, fetch: f })).toThrow(/model is required/);
    expect(() => createOllamaEmbeddingModel({ model: 'm', dimensions: 0, fetch: f })).toThrow(/dimensions/);
    expect(() => createOllamaEmbeddingModel({ model: 'm', dimensions: 1.5, fetch: f })).toThrow(/dimensions/);
    expect(() => createOllamaEmbeddingModel({ model: 'm', dimensions: 3, batchSize: 0, fetch: f })).toThrow(/batchSize/);
    expect(() => createOllamaEmbeddingModel({ model: 'm', dimensions: 3, url: 'nope', fetch: f })).toThrow(/invalid url/);
  });

  it('fails when no fetch exists', () => {
    const real = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = undefined;
    try {
      expect(() => createOllamaEmbeddingModel({ model: 'm', dimensions: 3 })).toThrow(/no fetch/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
