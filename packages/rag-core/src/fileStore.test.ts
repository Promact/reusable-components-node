import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileVectorStore, FileVectorStore } from './fileStore';
import { createIngestionPipeline } from './pipeline';
import { markdownExtractor } from './extractors';
import { EmbeddingModel } from './models';

// A plain-object copy of fs so individual functions (e.g. rmSync) can be spied on.
jest.mock('fs', () => ({ ...jest.requireActual('fs') }));

const rec = (id: string, tenantId: string, acl: string[], text: string, vector: number[], over: object = {}) => ({
  chunk: { chunkId: id, documentId: 'd', ordinal: 0, text, tokenCount: 1, headingPath: ['H'], contentHash: `h-${id}`, ...over },
  vector: Float32Array.from(vector), modelId: 'm', tenantId, aclGroups: acl, documentVersion: 1,
});
const def = { name: 'c', dimensions: 2, modelId: 'm' };
const q = (tenantId = 't1', aclGroups = ['g1']) => ({ filter: { tenantId, aclGroups }, topK: 10, mode: 'vector' as const, vector: Float32Array.from([1, 0]) });

let dir: string;
let file: string;
const opened: FileVectorStore[] = [];
const open = (p = file): FileVectorStore => {
  const s = fileVectorStore({ path: p });
  opened.push(s);
  return s;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-file-store-'));
  file = path.join(dir, 'index.json');
});
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('fileVectorStore', () => {
  it('validates options eagerly', () => {
    expect(() => fileVectorStore(undefined as never)).toThrow('options.path');
    expect(() => fileVectorStore({ path: '' })).toThrow('options.path');
  });

  it('creates the snapshot and lock owner-only (0600), since they hold every tenant\'s text', async () => {
    const mask = process.umask(0o022);
    try {
      const s = open();
      await s.ensureCollection(def);
      await s.upsert('c', [rec('a', 't1', ['g1'], 'secret', [1, 0])]);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(`${file}.lock`).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(mask);
    }
  });

  it('keeps the index across a restart, including vectors, metadata and parents', async () => {
    const s = open();
    await s.ensureCollection(def);
    await s.upsert('c', [
      rec('a', 't1', ['g1'], 'apples', [1, 0], { metadata: { role: 'leaf' }, pageStart: 3 }),
      { ...rec('p', 't1', ['g1'], 'parent text', []), chunk: { ...rec('p', 't1', ['g1'], 'parent text', []).chunk, metadata: { role: 'parent' } } },
    ]);
    await s.close();

    const r = open();
    await r.ensureCollection(def); // existing collection: no error, no rewrite needed
    const hits = await r.search('c', q());
    expect(hits).toHaveLength(1);
    expect(hits[0].chunk).toMatchObject({ chunkId: 'a', text: 'apples', pageStart: 3, headingPath: ['H'], metadata: { role: 'leaf' } });
    expect(Array.from(hits[0].vector!)).toEqual([1, 0]);
    expect(hits[0].score).toBeCloseTo(1);
    expect(await r.getByIds('c', q().filter, ['p'])).toEqual([expect.objectContaining({ chunkId: 'p', text: 'parent text' })]);
    expect((await r.findByContentHash('c', ['h-a'], 'm')).get('h-a')).toEqual(Float32Array.from([1, 0]));
    expect(await r.listDocument('c', { tenantId: 't1', documentId: 'd' })).toHaveLength(2);
  });

  it('round-trips non-trivial float vectors exactly', async () => {
    const v = [0.1234567, -3.5e-8, 1e30, -0];
    const s = open();
    await s.ensureCollection({ ...def, dimensions: 4 });
    await s.upsert('c', [rec('a', 't1', ['g1'], 'x', v)]);
    await s.close();
    const r = open();
    const [hit] = await r.search('c', { ...q(), vector: Float32Array.from([1, 1, 1, 1]) });
    expect(Array.from(hit.vector!)).toEqual(Array.from(Float32Array.from(v)));
  });

  it('persists deletes and keeps tenant/ACL filtering after reload (no leakage)', async () => {
    const s = open();
    await s.ensureCollection(def);
    await s.upsert('c', [rec('a', 't1', ['g1'], 'mine', [1, 0]), rec('a', 't2', ['g1'], 'other tenant', [1, 0]), rec('b', 't1', ['g2'], 'other group', [1, 0])]);
    await s.delete('c', { tenantId: 't1', chunkIds: ['b'] });
    await s.close();

    const r = open();
    expect((await r.search('c', q())).map((h) => h.chunk.text)).toEqual(['mine']);
    expect((await r.search('c', q('t2'))).map((h) => h.chunk.text)).toEqual(['other tenant']);
    expect(await r.search('c', q('t1', ['g2']))).toEqual([]);
  });

  it('writes every mutation before it resolves (no close needed for durability)', async () => {
    const s = open();
    await s.ensureCollection(def);
    await s.upsert('c', [rec('a', 't1', ['g1'], 'apples', [1, 0])]);
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(snap).toMatchObject({ format: 'promact-rag-file-store', version: 1 });
    expect(snap.collections[0].records[0].vector).toBe(Buffer.from(Float32Array.from([1, 0]).buffer).toString('base64'));
  });

  it('only rewrites the file on ensureCollection when a collection is created', async () => {
    const s = open();
    await s.ensureCollection(def);
    const t = fs.statSync(file).mtimeMs;
    fs.utimesSync(file, new Date(0), new Date(0));
    await s.ensureCollection(def);
    expect(fs.statSync(file).mtimeMs).toBe(0);
    expect(t).toBeGreaterThan(0);
  });

  it('persists the partial state when a mutation throws part-way, so file and memory agree', async () => {
    const s = open();
    await s.ensureCollection(def);
    await expect(s.upsert('c', [rec('a', 't1', ['g1'], 'ok', [1, 0]), rec('b', 't1', ['g1'], 'bad', [1, 0, 0])])).rejects.toThrow('dimensions');
    await s.close();
    const r = open();
    expect((await r.search('c', q())).map((h) => h.chunk.chunkId)).toEqual(['a']);
  });

  it('survives a crash mid-write: a leftover temp file never replaces the last good snapshot', async () => {
    const s = open();
    await s.ensureCollection(def);
    await s.upsert('c', [rec('a', 't1', ['g1'], 'apples', [1, 0])]);
    await s.close();
    fs.writeFileSync(`${file}.99999.tmp`, '{"format":"promact-rag-fi'); // torn write from a killed process
    const r = open();
    expect(await r.search('c', q())).toHaveLength(1);
  });

  it('allows only one process per file and releases the lock on close', async () => {
    const s = open();
    expect(() => fileVectorStore({ path: file })).toThrow(/already open .*pid \d+/);
    await s.close();
    await s.close(); // idempotent
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    open();
  });

  it('takes over a lock left by a dead process on this host', () => {
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname() }));
    expect(() => open()).not.toThrow();
  });

  it('does not take over a lock from another host or an unreadable lock', () => {
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, host: 'other-host' }));
    expect(() => fileVectorStore({ path: file })).toThrow('on other-host');
    fs.writeFileSync(`${file}.lock`, 'garbage');
    expect(() => fileVectorStore({ path: file })).toThrow('already open');
  });

  it('treats a live process owned by another user (EPERM) as alive', () => {
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    try {
      fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 1, host: os.hostname() }));
      expect(() => fileVectorStore({ path: file })).toThrow('already open');
    } finally {
      kill.mockRestore();
    }
  });

  it('gives up if the lock is re-taken by a live process during takeover', () => {
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname() }));
    const rm = jest.spyOn(jest.requireMock<typeof fs>('fs'), 'rmSync').mockImplementationOnce(() => {
      fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 54321, host: os.hostname() }));
    });
    try {
      expect(() => fileVectorStore({ path: file })).toThrow('already open');
    } finally {
      rm.mockRestore();
    }
  });

  it('surfaces lock errors other than "already exists"', () => {
    expect(() => fileVectorStore({ path: path.join(dir, 'missing-dir', 'x.json') })).toThrow(/ENOENT/);
  });

  it('rejects foreign or newer-format files and releases the lock', () => {
    fs.writeFileSync(file, JSON.stringify({ format: 'something-else' }));
    expect(() => fileVectorStore({ path: file })).toThrow('not a RAG file store');
    fs.writeFileSync(file, JSON.stringify({ format: 'promact-rag-file-store', version: 2, collections: [] }));
    expect(() => fileVectorStore({ path: file })).toThrow('format version 2');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('refuses use after close', async () => {
    const s = open();
    await s.close();
    await expect(s.ensureCollection(def)).rejects.toThrow('closed');
    await expect(s.upsert('c', [])).rejects.toThrow('closed');
    await expect(s.delete('c', { tenantId: 't1' })).rejects.toThrow('closed');
    await expect(s.search('c', q())).rejects.toThrow('closed');
    await expect(s.findByContentHash('c', [], 'm')).rejects.toThrow('closed');
    await expect(s.listDocument('c', { tenantId: 't1', documentId: 'd' })).rejects.toThrow('closed');
    await expect(s.getByIds('c', q().filter, [])).rejects.toThrow('closed');
  });

  it('reports a failed write to its caller and keeps working for later writes', async () => {
    const s = open();
    await s.ensureCollection(def);
    const rename = jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(s.upsert('c', [rec('a', 't1', ['g1'], 'apples', [1, 0])])).rejects.toThrow('disk full');
    } finally {
      rename.mockRestore();
    }
    await s.upsert('c', [rec('b', 't1', ['g1'], 'bananas', [1, 0])]);
    await s.close();
    expect((await open().search('c', q())).map((h) => h.chunk.chunkId).sort()).toEqual(['a', 'b']);
  });

  it('closes the temp file handle even when writing fails', async () => {
    const s = open();
    const realOpen = fs.promises.open;
    const spy = jest.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args: Parameters<typeof realOpen>) => {
      const fh = await realOpen(...args);
      fh.writeFile = () => Promise.reject(new Error('io error'));
      return fh;
    });
    try {
      await expect(s.ensureCollection(def)).rejects.toThrow('io error');
    } finally {
      spy.mockRestore();
    }
  });

  it('works as the store behind the ingestion pipeline: unchanged re-ingest after restart embeds nothing', async () => {
    const DIMS = 8;
    let embedded = 0;
    const emb: EmbeddingModel = {
      modelId: 'fake', dimensions: DIMS,
      async embed(texts) {
        embedded += texts.length;
        return texts.map((t) => Float32Array.from({ length: DIMS }, (_, i) => (t.charCodeAt(i % t.length) % 7) + 1));
      },
    };
    const source = {
      documentId: 'doc1', content: Buffer.from('# A\n\nAlpha text.\n\n## B\n\nBeta text.\n'), contentType: 'text/markdown',
      documentVersion: 1, tenantId: 'acme', aclGroups: ['hr'],
    };
    const pipe = (store: FileVectorStore) => createIngestionPipeline({
      collection: 'kb', extractors: [markdownExtractor()], embeddings: emb, vectorStore: store,
      chunking: { targetTokens: 50, maxTokens: 100, overlapTokens: 0 },
    });
    const s = open();
    expect((await pipe(s).ingest(source)).outcome).toBe('indexed');
    const first = embedded;
    expect(first).toBeGreaterThan(0);
    await s.close();

    const r = open();
    expect((await pipe(r).ingest(source)).outcome).toBe('unchanged');
    expect(embedded).toBe(first);
  });
});
