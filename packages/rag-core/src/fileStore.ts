import * as fs from 'fs';
import * as os from 'os';
import { ChunkRecord, VectorStore } from './models';
import { Collection, storeOver } from './storeCore';

const FORMAT = 'promact-rag-file-store';
const VERSION = 1;

export interface FileVectorStoreOptions {
  /** Snapshot file. A `<path>.lock` file next to it marks the single process that has it open. */
  path: string;
}

export interface FileVectorStore extends VectorStore {
  /** Waits for pending writes, then releases the lock. The store cannot be used afterwards. */
  close(): Promise<void>;
}

interface StoredRecord extends Omit<ChunkRecord, 'vector'> {
  vector: string;
}

interface Snapshot {
  format: string;
  version: number;
  collections: { def: Collection['def']; records: StoredRecord[] }[];
}

const encodeVector = (v: Float32Array): string => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');

function decodeVector(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  // Copy into a fresh buffer: Buffer's pooled memory is not guaranteed to be 4-byte aligned.
  const out = new Float32Array(buf.byteLength / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes `<path>.lock`; a lock left by a dead process on this host is taken over. */
function acquireLock(lockPath: string): void {
  const owner = { pid: process.pid, host: os.hostname() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(owner), { flag: 'wx' });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let held: { pid?: unknown; host?: unknown } = {};
      try {
        held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch {
        // unreadable lock: treat as held by an unknown process
      }
      const stale = held.host === owner.host && typeof held.pid === 'number' && !pidAlive(held.pid);
      if (!stale || attempt > 0) {
        throw new Error(
          `file store is already open (lock ${lockPath} held by pid ${String(held.pid)} on ${String(held.host)}); ` +
            'only one process may use a file store at a time',
        );
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function load(path: string): Map<string, Collection> {
  const collections = new Map<string, Collection>();
  if (!fs.existsSync(path)) return collections;
  const snap = JSON.parse(fs.readFileSync(path, 'utf8')) as Snapshot;
  if (snap.format !== FORMAT) throw new Error(`${path} is not a RAG file store`);
  if (snap.version !== VERSION) throw new Error(`${path} has file-store format version ${snap.version}; expected ${VERSION}`);
  for (const c of snap.collections) {
    const records = new Map<string, ChunkRecord>();
    for (const r of c.records) {
      records.set(`${r.tenantId}\u0000${r.chunk.chunkId}`, { ...r, vector: decodeVector(r.vector) });
    }
    collections.set(c.def.name, { def: c.def, records });
  }
  return collections;
}

/**
 * VectorStore persisted to one local file, for small single-server projects with no database
 * (spec §10.3). Same behaviour as the in-memory store; every mutating call is written to disk
 * atomically (temp file + fsync + rename) before it resolves. Only one process may open a file.
 */
export function fileVectorStore(options: FileVectorStoreOptions): FileVectorStore {
  if (!options || typeof options.path !== 'string' || !options.path) {
    throw new Error('fileVectorStore requires options.path');
  }
  const { path } = options;
  const lockPath = `${path}.lock`;
  acquireLock(lockPath);
  let collections: Map<string, Collection>;
  try {
    collections = load(path);
  } catch (e) {
    fs.rmSync(lockPath, { force: true });
    throw e;
  }
  const inner = storeOver(collections);
  let closed = false;
  let writes: Promise<void> = Promise.resolve();

  const write = async (): Promise<void> => {
    const snap: Snapshot = {
      format: FORMAT,
      version: VERSION,
      collections: [...collections.values()].map((c) => ({
        def: c.def,
        records: [...c.records.values()].map((r) => ({ ...r, vector: encodeVector(r.vector) })),
      })),
    };
    const tmp = `${path}.${process.pid}.tmp`;
    const fh = await fs.promises.open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(snap));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.promises.rename(tmp, path);
  };

  /** Writes are queued so snapshots land in call order; a failed write rejects its own caller only. */
  const flush = (): Promise<void> => {
    const next = writes.then(write);
    writes = next.catch(() => undefined);
    return next;
  };

  const open = (): void => {
    if (closed) throw new Error('file store is closed');
  };

  /** Persists even when the mutation throws part-way, so the file always matches memory. */
  async function mutate<T>(run: () => Promise<T>): Promise<T> {
    open();
    try {
      return await run();
    } finally {
      await flush();
    }
  }

  return {
    capabilities: inner.capabilities,

    async ensureCollection(def, signal) {
      open();
      const before = collections.size;
      await inner.ensureCollection(def, signal);
      if (collections.size !== before) await flush();
    },
    upsert: (collection, records, signal) => mutate(() => inner.upsert(collection, records, signal)),
    delete: (collection, filter, signal) => mutate(() => inner.delete(collection, filter, signal)),
    findByContentHash: async (...args) => (open(), inner.findByContentHash(...args)),
    search: async (...args) => (open(), inner.search(...args)),
    listDocument: async (...args) => (open(), inner.listDocument(...args)),
    getByIds: async (...args) => (open(), inner.getByIds(...args)),

    async close() {
      if (closed) return;
      closed = true;
      await writes;
      fs.rmSync(lockPath, { force: true });
    },
  };
}
