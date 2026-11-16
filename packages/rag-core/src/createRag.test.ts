import { createRag, RagConfigError, RagOptions } from './createRag';
import { VectorStore } from './models';

const store = { capabilities: { hybrid: false, keyword: false, returnsVectors: true } } as unknown as VectorStore;
const base = (): RagOptions => ({
  collection: 'kb',
  chunking: { targetTokens: 400, maxTokens: 600, overlapTokens: 0 },
  tokenizer: 'o200k_base',
  extractors: [{ canExtract: (t) => t === 'text/plain', extract: jest.fn() }],
  contentTypes: ['text/plain'],
  embeddings: { modelId: 'fake', dimensions: 8, embed: jest.fn() },
  vectorStore: store,
});
const bad = (patch: Partial<RagOptions> | ((o: RagOptions) => void), msg: RegExp) => {
  const o = base();
  if (typeof patch === 'function') patch(o);
  else Object.assign(o, patch);
  expect(() => createRag(o)).toThrow(RagConfigError);
  expect(() => createRag(o)).toThrow(msg);
};

describe('createRag', () => {
  it('accepts a valid config', () => {
    expect(createRag(base()).options.collection).toBe('kb');
    const o = base();
    delete o.contentTypes;
    delete o.tokenizer;
    o.graph = { chat: { modelId: 'c', completeJson: jest.fn() } };
    expect(() => createRag(o)).not.toThrow();
  });

  it('rejects bad config eagerly', () => {
    expect(() => createRag(undefined as unknown as RagOptions)).toThrow(/options are required/);
    bad({ collection: ' ' }, /collection/);
    bad({ chunking: { targetTokens: 0, maxTokens: 10, overlapTokens: 0 } }, /positive integers/);
    bad({ chunking: undefined as never }, /positive integers/);
    bad({ chunking: { targetTokens: 700, maxTokens: 600, overlapTokens: 0 } }, /<= maxTokens/);
    bad({ chunking: { targetTokens: 400, maxTokens: 600, overlapTokens: 400 } }, /overlapTokens/);
    bad({ chunking: { targetTokens: 400, maxTokens: 600, overlapTokens: -1 } }, /overlapTokens/);
    bad({ tokenizer: 'nope' as never }, /tokenizer/);
    bad({ extractors: undefined as never }, /extractors/);
    bad({ contentTypes: ['application/pdf'] }, /application\/pdf/);
    bad({ embeddings: { modelId: '', dimensions: 8, embed: jest.fn() } }, /embeddings/);
    bad({ embeddings: { modelId: 'm', dimensions: 1.5, embed: jest.fn() } }, /embeddings/);
    bad({ vectorStore: undefined as never }, /vectorStore/);
    bad({ graph: {} }, /chat model/);
  });

  it('getContext refuses a query without a tenant filter before embedding or searching', async () => {
    const o = base();
    const rag = createRag(o);
    await expect(rag.getContext({ text: 'x', filter: { tenantId: '', aclGroups: [] } }, { maxTokens: 10 })).rejects.toThrow(/tenantId/);
    await expect(rag.getContext({ text: 'x', filter: undefined as never }, { maxTokens: 10 })).rejects.toThrow(/tenantId/);
    expect(o.embeddings.embed).not.toHaveBeenCalled();
  });
});
