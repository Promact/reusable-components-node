import OpenAI from 'openai';
import { createOpenAiEmbeddings, EmbeddingsClient } from './index';

function fakeClient(dimsOf = (n: number) => n, shuffle = false) {
  const create = jest.fn(async (body: { input: string[]; dimensions?: number }) => {
    const data = body.input.map((t, index) => ({
      index,
      embedding: Array(body.dimensions ?? dimsOf(3)).fill(t.length),
    }));
    return { data: shuffle ? data.reverse() : data };
  });
  return { client: { embeddings: { create } } as EmbeddingsClient, create };
}

describe('createOpenAiEmbeddings', () => {
  it('batches, restores order and passes dimensions, signal and float format', async () => {
    const { client, create } = fakeClient(() => 1536, true);
    const m = createOpenAiEmbeddings({
      model: 'text-embedding-3-small',
      client,
      batchSize: 2,
    });
    expect(m.dimensions).toBe(1536);
    expect(m.modelId).toBe('openai:text-embedding-3-small');
    const ctl = new AbortController();
    const out = await m.embed(['a', 'bb', 'ccc'], ctl.signal);
    expect(out.map((v) => v[0])).toEqual([1, 2, 3]);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({ encoding_format: 'float', input: ['a', 'bb'] });
    expect(create.mock.calls[0][0]).not.toHaveProperty('dimensions');
    expect((create.mock.calls[0] as unknown[])[1]).toEqual({ signal: ctl.signal });
  });

  it('requests shortened vectors', async () => {
    const { client, create } = fakeClient();
    const m = createOpenAiEmbeddings({ model: 'text-embedding-3-large', dimensions: 256, client });
    expect(m.dimensions).toBe(256);
    expect(m.modelId).toBe('openai:text-embedding-3-large@256');
    const [v] = await m.embed(['x']);
    expect(v.length).toBe(256);
    expect(create.mock.calls[0][0].dimensions).toBe(256);
  });

  it('supports custom models via nativeDimensions or dimensions', () => {
    const { client } = fakeClient();
    expect(createOpenAiEmbeddings({ model: 'custom', nativeDimensions: 768, client }).dimensions).toBe(768);
    expect(createOpenAiEmbeddings({ model: 'custom', dimensions: 64, client }).dimensions).toBe(64);
  });

  it('returns [] without calling the API', async () => {
    const { client, create } = fakeClient();
    expect(await createOpenAiEmbeddings({ model: 'text-embedding-3-small', client }).embed([])).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects wrong counts and wrong vector sizes', async () => {
    const bad = (data: unknown) =>
      createOpenAiEmbeddings({
        model: 'text-embedding-3-small',
        client: { embeddings: { create: async () => ({ data }) } } as unknown as EmbeddingsClient,
      });
    await expect(bad([]).embed(['x'])).rejects.toThrow(/expected 1 vectors, got 0/);
    await expect(bad(undefined).embed(['x'])).rejects.toThrow(/expected 1 vectors, got 0/);
    await expect(bad([{ index: 0, embedding: [1] }]).embed(['x'])).rejects.toThrow(/expected 1536 dimensions, got 1/);
  });

  it('propagates API errors', async () => {
    const client = { embeddings: { create: async () => { throw new Error('429'); } } } as unknown as EmbeddingsClient;
    await expect(createOpenAiEmbeddings({ model: 'text-embedding-3-small', client }).embed(['x'])).rejects.toThrow('429');
  });

  it('validates options eagerly', () => {
    const { client } = fakeClient();
    const base = { model: 'text-embedding-3-small', client };
    expect(() => createOpenAiEmbeddings(undefined as never)).toThrow(/model is required/);
    expect(() => createOpenAiEmbeddings({ model: '', client })).toThrow(/model is required/);
    expect(() => createOpenAiEmbeddings({ ...base, batchSize: 0 })).toThrow(/batchSize/);
    expect(() => createOpenAiEmbeddings({ ...base, batchSize: 5000 })).toThrow(/<= 2048/);
    expect(() => createOpenAiEmbeddings({ ...base, dimensions: -1 })).toThrow(/dimensions/);
    expect(() => createOpenAiEmbeddings({ ...base, nativeDimensions: 0 })).toThrow(/nativeDimensions/);
    expect(() => createOpenAiEmbeddings({ ...base, maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => createOpenAiEmbeddings({ ...base, timeoutMs: 0 })).toThrow(/timeoutMs/);
    expect(() => createOpenAiEmbeddings({ model: 'mystery', client })).toThrow(/unknown model/);
    expect(() => createOpenAiEmbeddings({ model: 'text-embedding-ada-002', dimensions: 256, client })).toThrow(/ada-002/);
    expect(() => createOpenAiEmbeddings({ ...base, dimensions: 4000 })).toThrow(/exceeds/);
  });

  it('builds a real OpenAI client (no network) and requires an apiKey', () => {
    const m = createOpenAiEmbeddings({
      model: 'text-embedding-3-small',
      apiKey: 'sk-test',
      baseURL: 'http://localhost:9/v1',
      maxRetries: 1,
      timeoutMs: 1000,
    });
    expect(m.modelId).toBe('openai:text-embedding-3-small');
    expect(() => createOpenAiEmbeddings({ model: 'text-embedding-3-small' })).toThrow(/apiKey/);
    expect(OpenAI).toBeDefined();
  });

  it('builds an Azure client (no network) and validates azure options', () => {
    const azure = { endpoint: 'https://r.openai.azure.com/', apiVersion: '2024-10-21' };
    const m = createOpenAiEmbeddings({ model: 'text-embedding-3-small', apiKey: 'k', azure });
    expect(m.modelId).toBe('azure-openai:text-embedding-3-small');
    expect(createOpenAiEmbeddings({ model: 'text-embedding-3-small', apiKey: 'k', azure: { ...azure, deployment: 'd' } })).toBeDefined();
    expect(() => createOpenAiEmbeddings({ model: 'text-embedding-3-small', apiKey: 'k', azure: { endpoint: '', apiVersion: 'v' } })).toThrow(/azure/);
    expect(() => createOpenAiEmbeddings({ model: 'text-embedding-3-small', azure })).toThrow(/apiKey/);
  });
});

describe('retry behaviour (real SDK client, mocked fetch)', () => {
  it('retries a 429 after Retry-After and then succeeds', async () => {
    const calls: number[] = [];
    const fetchMock = jest.fn(async () => {
      calls.push(Date.now());
      if (calls.length === 1) {
        return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after-ms': '50' } });
      }
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array(1536).fill(0.5) }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new OpenAI({ apiKey: 'k', maxRetries: 2, fetch: fetchMock as unknown as typeof fetch });
    const m = createOpenAiEmbeddings({ model: 'text-embedding-3-small', client: client as unknown as EmbeddingsClient });
    const [v] = await m.embed(['hello']);
    expect(v.length).toBe(1536);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(45);
  });
});
