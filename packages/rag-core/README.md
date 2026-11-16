# @promact/rag-core

Core of the Promact RAG library (private, work in progress). See `docs/specs/rag-service-spec.md`.

## Choosing a store

| Store | Use when |
|---|---|
| `memoryVectorStore()` | Tests and demos. Lost on restart. |
| `fileVectorStore({ path })` | Small apps on one server with no database. The whole index is loaded into memory; only one process may open a file. |
| `@promact/rag-store-pgvector` | Real products, several app instances, large document sets. |

```ts
import { fileVectorStore } from '@promact/rag-core';

const store = fileVectorStore({ path: './data/rag-index.json' });
// ... pass `store` as `vectorStore` to createRag / createIngestionPipeline
await store.close(); // on shutdown: waits for pending writes and releases the lock
```

Every change is written to disk before the call returns, using a temp file and an atomic rename,
so a crash never leaves a half-written index. Moving to Postgres later means re-ingesting your
documents.

## Embeddings

`createOllamaEmbeddingModel({ model: 'nomic-embed-text', dimensions: 768 })` talks to a local Ollama server over HTTP
(`POST /api/embed`, global `fetch`, no SDK). Other providers: `@promact/rag-embed-openai`, `@promact/rag-embed-local`.
