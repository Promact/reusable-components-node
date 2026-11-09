# SPEC: RAG Service for Node.js — Retrieval ("R") + GraphRAG

**Date:** 2026-11-09
**Status:** Proposed; product decisions recorded in §16. This is a spec only; no code exists yet.
**Target:** Node.js 22+, TypeScript (strict), the same toolchain as every package in this repo
(npm workspaces, `tsc`, Jest, ESLint).
**Proposed location:** `packages/rag-*` in this monorepo, plus a Docker image.
**Supersedes for Node:** the .NET plan in the sibling repo,
[`reusable-components/docs/specs/rag-retrieval-plan.md`](https://github.com/Promact/reusable-components/blob/master/docs/specs/rag-retrieval-plan.md)
and its [action items](https://github.com/Promact/reusable-components/blob/master/docs/specs/rag-retrieval-action-items.md).
The design decisions and review fixes from that plan (R1–R12) carry over. This spec changes the
platform to Node.js, adds GraphRAG, and adds a standalone service.

This document specifies the **Retrieval** part of a reusable RAG (Retrieval-Augmented
Generation) component. Augmentation ("A") and Generation ("G") are still deferred. §13 describes
the handoff contract so R does not need rework when they arrive.

The main goal of R is still **token efficiency**: an LLM should receive only the content it
needs, in the cheapest form that keeps the meaning. Most of the savings happen *before* anything
reaches the model: clean extraction, noise removal, good chunking, precise retrieval and
budgeted context packing. GraphRAG adds a second way to save tokens. A relationship rendered as
a compact fact (`Acme Corp —[acquired, 2024]→ Beta Ltd`) often replaces several paragraphs of
retrieved prose.

---

## 1. Delivery goals

The component ships in **two forms built from one codebase**:

| Goal | Form | Who uses it | How |
|---|---|---|---|
| **Goal 1** | **npm packages** (`@promact/rag-*`) | Node.js/TypeScript apps that want RAG inside their own process | `npm install @promact/rag-core @promact/rag-extract-pdf …` and call it from code |
| **Goal 2** | **Standalone service** (`@promact/rag-server` + Docker image) | Any app in **any framework or language** (.NET, Python, Java, PHP, Go, front-end BFFs…) | `docker run` / `docker compose up`, then call the HTTP API |

**Rules that keep the two forms identical:**

- The server is a **thin HTTP layer over the same packages**. It contains no retrieval logic
  of its own, so a bug fix or improvement in a package reaches both forms.
- The library is built first (Goal 1), including GraphRAG. The server (Goal 2) is a **later
  stage**: it starts only after the library's public API is stable, after v0.3 (§14).
- Behaviour parity is tested. The same golden-set evaluation (§11.2) runs against the library
  directly and against the server over HTTP, and the results must match.

---

## 2. Goals and non-goals

### Functional goals

1. **Extract** content from common business documents (PDF, DOCX, XLSX, PPTX, HTML, Markdown,
   TXT, and scanned or image-only files through an OCR provider) into one structured,
   token-efficient element model.
2. **Reduce tokens at ingestion.** Strip boilerplate (repeated headers/footers, page numbers,
   navigation, TOCs), normalize whitespace and Unicode, compact tables, de-duplicate.
3. **Chunk** in a structure-aware, token-budgeted way. Sizes are measured in tokens, not
   characters.
4. **Index** chunks with embeddings into a pluggable vector store, incrementally: unchanged
   content is never re-embedded.
5. **Build a knowledge graph (GraphRAG, opt-in).** Extract entities, relationships and claims
   from chunks, resolve duplicate entities, detect communities and summarize them (§7).
6. **Retrieve** with vector, keyword, hybrid or **graph** search (local, global, or mixed with
   vector), with mandatory tenant/ACL filters, MMR diversity and optional reranking.
7. **Pack context** into a caller-specified token budget with compact citations. This is the
   output R hands to A/G.
8. **Measure everything.** Token counts before and after each stage, retrieval quality
   (recall@k, MRR, nDCG) and latency, through OpenTelemetry.
9. **Run anywhere.** As a library inside a Node app, or as a container that any stack calls
   over HTTP (§9).

### Non-goals (for this phase)

- Prompt construction (A) and LLM calls that answer the user (G).
- Agentic or multi-hop *planning* (an LLM deciding what to retrieve next). GraphRAG's k-hop
  graph expansion is in scope; LLM-driven iterative retrieval is not.
- Multimodal (image) embeddings. Images are skipped or replaced by a caption/alt-text element.
- Hosting a vector database or graph database. We integrate with existing ones and ship
  `docker compose` examples that start them.
- A UI or admin portal. The server exposes an API and OpenAPI docs only.

**Change from the .NET plan:** GraphRAG moves from non-goal to goal. Because graph extraction
needs an LLM, R now takes an **optional** dependency on a chat model, used **only** by the
GraphRAG packages and only at ingestion and community-summary time (§7.6). Plain vector
retrieval still needs no LLM.

---

## 3. Architecture overview

```
                     ┌────────────────────────── INGESTION (background) ──────────────────────────┐
 Source              │                                                                             │
 (file upload,    ──►│ Extract ─► Clean ─► Dedup ─► Chunk ─► Enrich ─► Embed ─► Upsert ────────────┼─► Vector store
  @promact/file-     │ (per fmt)  (chain)  (hash)   (token-  (heading (reuse   (incr.)             │
  service, URL)      │                              aware)   path,ACL) by hash)                    │
                     │                                 │                                           │
                     │                                 └─► [GraphRAG, opt-in] Extract entities/    │
                     │                                     relations (LLM) ─► Resolve entities ─►  ├─► Graph store
                     │                                     Communities ─► Summaries (LLM) ─► Embed │
                     └─────────────────────────────────────────────────────────────────────────────┘

                     ┌────────────────────────── RETRIEVAL (per query) ───────────────────────────┐
 Query + filters ──► │ Embed query ─► Search: vector | keyword | hybrid(RRF) | graph-local |       │
 + token budget      │                        graph-global | mix                                   │
                     │   ─► Security filter (in-query) ─► Threshold ─► MMR ─► Rerank (opt.)        ├─► RetrievedContext
                     │   ─► Context pack (budget, merge, order, chunk + graph-fact citations)      │   (text, citations,
                     └─────────────────────────────────────────────────────────────────────────────┘    token stats)

 Goal 2 only:   HTTP client (any language) ─► @promact/rag-server (Fastify) ─► the same packages above
```

**Layering rule:** `@promact/rag-core` has **no heavy or vendor dependencies**. It holds the
models, interfaces, pipelines, cleaners, chunker, retriever, context packer, TXT/Markdown
extraction and in-memory stores. Every heavy or vendor dependency (PDF parser, OOXML parsing,
ONNX runtime, a database driver, an LLM SDK) lives in its own package, so consumers install
only what they use.

---

## 4. Build on the Node.js ecosystem; don't reinvent it

Node has no equivalent of .NET's `Microsoft.Extensions.AI` / `Microsoft.Extensions.VectorData`
standard abstractions. That forces one real change from the .NET plan: **we define our own thin
`EmbeddingModel`, `VectorStore`, `GraphStore` and `ChatModel` interfaces** (the .NET plan could
avoid this). We keep them deliberately small (only what R calls) and ship adapters.

| Concern | Use | Notes |
|---|---|---|
| Embeddings | Our `EmbeddingModel` interface + adapters: OpenAI / Azure OpenAI (`openai`), Ollama (HTTP), local ONNX (`@huggingface/transformers`, i.e. transformers.js) | Phase 0 evaluates adopting the Vercel AI SDK (`ai`, `embedMany`) as **one adapter** behind our interface, not as the public API, so a churn in that SDK can't break consumers. |
| Vector storage + search | Our `VectorStore` interface + adapters: in-memory (core), Postgres/pgvector (`pg`), Qdrant (`@qdrant/js-client-rest`), Azure AI Search (`@azure/search-documents`) | LangChain.js vector stores were considered and rejected as the public abstraction: too wide an API surface and too frequent breaking changes for a shared component. |
| Graph storage | Our `GraphStore` interface + adapters: in-memory (core), Postgres tables (same DB as pgvector), Neo4j (`neo4j-driver`) | Postgres lets the all-local stack run on **one database** for vectors and graph. |
| Graph algorithms | `graphology` + `graphology-communities-louvain` (MIT) | Community detection for global search. Microsoft GraphRAG uses Leiden; no maintained JS Leiden exists, so we use Louvain and record this in the ADR. |
| Token counting | `gpt-tokenizer` or `js-tiktoken` (pure JS, no native build) | Phase 0 picks one. An approximate counter covers vendors without a local tokenizer (e.g. Claude), as in .NET R6. |
| Chat model (GraphRAG only) | Our `ChatModel` interface + adapters: OpenAI / Azure OpenAI, Anthropic (`@anthropic-ai/sdk`), Ollama | Used for entity/relationship extraction and community summaries. Structured (JSON) output required. |
| HTTP server (Goal 2) | Fastify (MIT) + `@fastify/multipart` + JSON-schema validation | Fast, schema-first, generates OpenAPI from route schemas. |
| Background jobs (Goal 2) | In-process queue by default; BullMQ (Redis) optional for multi-replica deployments | See §9.4. |
| Telemetry | `@opentelemetry/api` (spans + metrics) | Consumers bring their own SDK/exporter; the server image includes the OTLP exporter. |

**What the packages add on top:** good-quality extraction into a structured element model,
token-reducing cleanup, structure-aware chunking, incremental ingestion, GraphRAG extraction and
query, hybrid/MMR/rerank orchestration, security trimming and **budgeted context packing**.

> **Verify versions and licences at implementation time** against the npm registry
> (`npm view <pkg> version license`), not from memory. Several packages above move quickly.
> Only permissive licences (MIT / Apache-2.0 / BSD / ISC) are allowed in default packages.

---

## 5. Package layout (Goal 1)

The existing packages in this repo bundle all their providers in one package (e.g.
`@promact/file-service` depends on both the AWS and Azure SDKs). RAG **deliberately departs**
from that. Its provider dependencies are large (pdf.js, ONNX runtime with model weights,
database drivers), so bundling them would make every consumer download all of them. Each
heavy dependency gets its own package.

```
packages/
├── rag-core/               → @promact/rag-core              models, interfaces, pipelines, cleaners, chunker,
│                                                             retriever, packer, TXT/Markdown, in-memory stores
├── rag-extract-pdf/        → @promact/rag-extract-pdf       pdf.js (`pdfjs-dist` / `unpdf`, Apache-2.0 / MIT)
├── rag-extract-office/     → @promact/rag-extract-office    DOCX (`mammoth`, BSD-2), XLSX (`exceljs`, MIT),
│                                                             PPTX (OOXML via `yauzl` + `fast-xml-parser`, MIT)
├── rag-extract-html/       → @promact/rag-extract-html      `cheerio` + `@mozilla/readability` (MIT / Apache-2.0)
├── rag-extract-ocr/        → @promact/rag-extract-ocr       local OCR, `tesseract.js` (Apache-2.0), offline
├── rag-extract-azure-di/   → @promact/rag-extract-azure-di  Azure Document Intelligence (cloud OCR + layout)
├── rag-embed-openai/       → @promact/rag-embed-openai      OpenAI + Azure OpenAI embeddings
├── rag-embed-local/        → @promact/rag-embed-local       transformers.js ONNX models (no egress)
├── rag-store-pgvector/     → @promact/rag-store-pgvector    vectors + graph tables in Postgres
├── rag-store-qdrant/       → @promact/rag-store-qdrant
├── rag-store-azure-search/ → @promact/rag-store-azure-search
├── rag-graph/              → @promact/rag-graph             GraphRAG: extraction, entity resolution, communities,
│                                                             local/global/mix search (graphology)
├── rag-graph-neo4j/        → @promact/rag-graph-neo4j       Neo4j GraphStore adapter
├── rag-llm-openai/         → @promact/rag-llm-openai        ChatModel adapter (OpenAI / Azure OpenAI)
├── rag-llm-anthropic/      → @promact/rag-llm-anthropic     ChatModel adapter (Claude)
├── rag-rerank-cohere/      → @promact/rag-rerank-cohere
├── rag-server/             → @promact/rag-server            Goal 2: Fastify HTTP service + CLI + Dockerfile
└── rag-client/             → @promact/rag-client            typed TS client generated from the server's OpenAPI
```

**MVP (v0.1) is narrower** (see §14): `rag-core`, `rag-extract-pdf`, `rag-extract-office`,
`rag-embed-openai`, `rag-embed-local`, `rag-store-pgvector`. Everything else ships in later
minor releases. Each package is additive, so nothing blocks.

**Ollama** needs no SDK (plain HTTP), so its embedding and chat adapters live in `rag-core`
(`OllamaEmbeddingModel`, `OllamaChatModel`). That gives the all-local stack the fewest installs.

**Licensing rule:** only permissive-licence parsers in default packages. No AGPL (e.g. MuPDF
bindings) and no commercial parsers. SheetJS (`xlsx`) is **not** used: the npm-registry release
is outdated and current versions are only distributed from the vendor's CDN.

---

## 6. Core contracts (sketch)

Illustrative TypeScript showing shape and responsibility. Final names are settled in the Phase 0
ADR. Every async method takes an optional `AbortSignal` (the Node equivalent of .NET's
`CancellationToken`).

### 6.1 Structured document model

```ts
// Content ownership: the caller owns `content`; extractors read it once and never destroy the stream.
// Security fields are typed and required, so they cannot be silently omitted (.NET R3).
export interface DocumentSource {
  documentId: string;
  content: Buffer | NodeJS.ReadableStream;
  contentType: string;
  fileName?: string;
  documentVersion: number;            // last-writer-wins (§6.4)
  tenantId: string;
  aclGroups: readonly string[];
  metadata?: Readonly<Record<string, string>>;   // source URI, custom fields…
}

export type DocumentElement =
  | { kind: 'heading'; level: number; text: string; page?: number }
  | { kind: 'paragraph'; text: string; page?: number }
  | { kind: 'list'; items: string[]; ordered: boolean; page?: number }
  | { kind: 'table'; header: string[]; rows: string[][]; page?: number }
  | { kind: 'code'; text: string; language?: string; page?: number }
  | { kind: 'image'; caption?: string; page?: number };        // no pixels in R

export interface ExtractedDocument {
  documentId: string;
  contentHash: string;
  elements: DocumentElement[];
  stats: ExtractionStats;             // raw chars/tokens, pages, elements dropped, pages needing OCR
}
```

A discriminated union (`kind`) replaces the .NET record hierarchy; it is the idiomatic TS shape
and narrows cleanly in `switch` statements.

The **canonical text rendering is compact Markdown**: `#` headings, tables as Markdown tables
or CSV (whichever has fewer tokens), no styling.

### 6.2 Ingestion

```ts
export interface DocumentExtractor {
  canExtract(contentType: string, fileName?: string): boolean;
  extract(source: DocumentSource, options: ExtractionOptions, signal?: AbortSignal): Promise<ExtractedDocument>;
}

export interface ContentCleaner {          // ordered chain; each step reports what it removed
  clean(doc: ExtractedDocument, signal?: AbortSignal): Promise<ExtractedDocument>;
}

export interface Chunker {
  chunk(doc: ExtractedDocument, options: ChunkingOptions, signal?: AbortSignal): AsyncIterable<DocumentChunk>;
}

export interface DocumentChunk {
  chunkId: string;              // hash(documentId, contentHash, occurrence) — NOT ordinal (.NET R2)
  documentId: string;
  ordinal: number;              // stored as data only
  text: string;
  tokenCount: number;
  headingPath: string[];        // ["Leave Policy", "Sick Leave"]
  parentChunkId?: string;       // small-to-big
  pageStart?: number;
  pageEnd?: number;
  contentHash: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface IngestionPipeline {
  ingest(source: DocumentSource, signal?: AbortSignal): Promise<IngestionResult>;
  deleteDocument(documentId: string, tenantId: string, signal?: AbortSignal): Promise<void>;
}

export interface IngestionResult {
  documentId: string;
  outcome: 'indexed' | 'unchanged' | 'updated' | 'stale' | 'failed';
  rawTokens: number;
  cleanTokens: number;
  chunkCount: number;
  chunksEmbedded: number;
  chunksReused: number;
  graph?: { entitiesAdded: number; relationsAdded: number; llmTokensUsed: number };
}
```

### 6.3 Provider interfaces (ours, kept minimal)

```ts
export interface EmbeddingModel {
  readonly modelId: string;            // stored per record; detects stale vectors
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface VectorStore {
  readonly capabilities: { hybrid: boolean; keyword: boolean; returnsVectors: boolean };
  ensureCollection(def: CollectionDefinition, signal?: AbortSignal): Promise<void>;
  upsert(collection: string, records: ChunkRecord[], signal?: AbortSignal): Promise<void>;
  delete(collection: string, filter: RecordFilter, signal?: AbortSignal): Promise<void>;
  findByContentHash(collection: string, hashes: string[], modelId: string, signal?: AbortSignal): Promise<Map<string, Float32Array>>;
  search(collection: string, request: SearchRequest, signal?: AbortSignal): Promise<ScoredChunk[]>;
}

export interface TokenCounter {
  count(text: string): number;
}

export interface ChatModel {             // GraphRAG only
  readonly modelId: string;
  completeJson<T>(request: { system: string; user: string; schema: object; maxTokens: number }, signal?: AbortSignal): Promise<{ value: T; usage: { inputTokens: number; outputTokens: number } }>;
}
```

`SearchRequest` **requires** a `RetrievalFilter` (§10). There is no overload without it.
Adapters must apply it inside the database query.

### 6.4 Retrieval

```ts
export interface RetrievalQuery {
  text: string;
  filter: RetrievalFilter;               // REQUIRED: tenantId + principal's aclGroups
  topK?: number;                         // default 20
  minScore?: number;
  mode?: 'vector' | 'keyword' | 'hybrid' | 'graph-local' | 'graph-global' | 'mix';   // default 'hybrid'
  mmr?: { enabled: boolean; lambda: number };                                       // default on, 0.7
}

export interface ContextBudget {
  maxTokens: number;                     // default 4000 (§16)
  safetyMarginPercent?: number;          // default 5 (15 for the approximate counter)
  format?: 'markdown';
}

export interface RetrievedContext {
  text: string;                          // what A/G will put in the prompt
  citations: Citation[];                 // [1] → chunk (document, page, heading path) or [G1] → graph fact (source chunks)
  tokensUsed: number;
  candidatesConsidered: number;
  chunksIncluded: number;
  chunksDropped: number;
  graphFactsIncluded: number;
}

// The facade most consumers call:
export interface KnowledgeRetriever {
  getContext(query: RetrievalQuery, budget: ContextBudget, signal?: AbortSignal): Promise<RetrievedContext>;
}
```

### 6.5 Wiring (factory style, matching this repo)

Packages in this repo are wired with `createXxxService(options)` factories that validate
eagerly, not a DI container. RAG follows that:

```ts
import { createRag } from '@promact/rag-core';
import { pdfExtractor } from '@promact/rag-extract-pdf';
import { officeExtractor } from '@promact/rag-extract-office';
import { openAiEmbeddings } from '@promact/rag-embed-openai';
import { pgVectorStore } from '@promact/rag-store-pgvector';
import { graphRag } from '@promact/rag-graph';
import { openAiChat } from '@promact/rag-llm-openai';

const rag = createRag({
  collection: 'kb-chunks',
  chunking: { targetTokens: 400, maxTokens: 600, overlapTokens: 0 },
  tokenizer: 'o200k_base',
  extractors: [pdfExtractor(), officeExtractor()],
  embeddings: openAiEmbeddings({ model: 'text-embedding-3-small', apiKey: process.env.OPENAI_API_KEY! }),
  vectorStore: pgVectorStore({ connectionString: process.env.DATABASE_URL! }),
  graph: graphRag({                                   // optional
    chat: openAiChat({ model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! }),
    store: 'same-as-vector-store',                    // Postgres graph tables
  }),
});

await rag.ingest({ documentId: 'hr-001', content: fs.createReadStream('policy.pdf'), contentType: 'application/pdf',
                   documentVersion: 3, tenantId: 'acme', aclGroups: ['hr'] });

const ctx = await rag.getContext(
  { text: 'How many sick days do contractors get?', filter: { tenantId: 'acme', aclGroups: ['hr', 'all'] } },
  { maxTokens: 3000 },
);
```

`createRag` throws at construction for invalid config (missing extractor for a declared type,
embedding dimensions that don't match an existing collection, graph mode without a chat model),
consistent with the construction-time validation in the existing packages.

---

## 7. GraphRAG

### 7.1 Why

Vector search finds passages that *look like* the query. It is weak at:

- **Relationship questions** ("Which suppliers are owned by companies we also sell to?"). The
  answer is spread across documents that are each individually dissimilar to the query.
- **Global / thematic questions** ("What are the main compliance risks across all contracts?").
  No single chunk answers them, and top-k retrieval returns an arbitrary few.

GraphRAG builds a knowledge graph at ingestion time and queries it at retrieval time. It is
**opt-in per collection**, because extraction costs LLM tokens (§7.6).

### 7.2 Graph model

| Element | Fields |
|---|---|
| **Entity** | `entityId`, `tenantId`, `name`, `type` (person, organization, product, policy, location, … configurable), `description`, `aliases[]`, `embedding`, `sourceChunkIds[]` |
| **Relationship** | `relId`, `tenantId`, `sourceEntityId`, `targetEntityId`, `type`, `description`, `weight`, `sourceChunkIds[]` |
| **Claim** (optional) | `claimId`, `subjectEntityId`, `text`, `status`, `dates`, `sourceChunkIds[]` |
| **Community** | `communityId`, `tenantId`, `level`, `memberEntityIds[]`, `summary`, `summaryEmbedding`, `sourceChunkIds[]` (union) |

Every graph element keeps `sourceChunkIds`. Those links are what make ACL trimming (§7.5),
citations and incremental updates possible.

### 7.3 Ingestion stages (after chunking)

1. **Entity & relationship extraction.** Each *cleaned* chunk goes to the `ChatModel` with a
   JSON-schema prompt (entity types configurable per collection). Optional "gleaning" passes
   (ask again for missed entities) are capped, default 0.
2. **Cached by chunk content hash.** An unchanged chunk is never sent to the LLM again. This is
   the GraphRAG equivalent of embedding reuse, and the biggest cost control.
3. **Entity resolution.** Merge duplicates by normalized name + type, then by embedding
   similarity of name+description above a threshold. Merges are recorded so they can be
   reversed if a source chunk is deleted.
4. **Community detection.** Louvain over the entity graph per tenant, hierarchical levels.
   Runs as a separate **batch job** (not per document), because communities change globally.
5. **Community summaries.** The `ChatModel` summarizes each community from its entities and
   relationships (token-budgeted input). Summaries are embedded for global search. Only
   communities whose membership changed are re-summarized.

### 7.4 Query modes

| Mode | How it works | Good for |
|---|---|---|
| `graph-local` | Embed the query → find matching entities (vector search on entity embeddings) → expand 1–2 hops (capped fan-out) → collect relationships + linked chunks → rank → pack. | Questions about specific things and how they relate. |
| `graph-global` *(later, M6)* | Search community summaries at a chosen level → pack the best summaries (with their source citations). Map-reduce answering over all communities is **A/G's job** and deferred. | Thematic / "across everything" questions. |
| `mix` | Run `hybrid` and `graph-local` in parallel; fuse with RRF; pack chunks and graph facts in one budget. | Default when graph is enabled; a safe choice when the question type is unknown. |

**Token-efficient rendering of graph facts:** relationships are packed as one-line triples
(`[G3] Acme Corp —acquired (2024)→ Beta Ltd`), and entities as `name (type): one-line
description`. They are far cheaper than the paragraphs they were extracted from. The packer
budgets chunks and facts together and drops the lowest-ranked items first.

### 7.5 Security in the graph

A graph merges information across documents, which can leak data between ACL groups even within
one tenant. Rules:

- **Tenant isolation is structural.** Entities, relationships and communities are always
  per-tenant; entity resolution never merges across tenants.
- **ACL trimming by provenance.** A relationship or entity description is shown to a principal
  only if **at least one** of its `sourceChunkIds` is visible to that principal. Descriptions
  are stored per source chunk, so a fact only seen in an `hr`-restricted document is not shown
  to someone without `hr`.
- **Community summaries are ACL-scoped.** A summary built from chunks with mixed ACLs could leak.
  Communities are summarized **per ACL partition** (the set of ACL groups of their source
  chunks); `graph-global` only returns summaries whose partition the principal can fully see.
  This costs extra summaries. If it proves too expensive, the fallback (decided in Phase 0) is
  to disable `graph-global` for collections with mixed ACLs.
- A dedicated leakage test covers both tenant and ACL cases (§14, M3 and M6).

### 7.6 Cost controls

GraphRAG spends LLM tokens at ingestion to save tokens at query time. The trade-off must be
visible and bounded:

- Opt-in per collection; vector-only collections never call an LLM.
- Extraction runs on **cleaned** chunks only (the token savings from §8.1–8.2 also cut graph cost).
- Results cached by chunk content hash; re-ingesting an unchanged document costs **0** LLM tokens.
- A per-collection **LLM token budget** for ingestion (stop and report when exceeded).
- Metrics: `rag.graph.llm.tokens.input/output`, entities/relations per chunk, extraction cost per
  document.
- Recommended model: a small, cheap model for extraction; a larger one optionally for summaries.

### 7.7 Graph storage

| Adapter | Package | Notes |
|---|---|---|
| In-memory | `rag-core` | Tests and small demos. |
| Postgres tables | `rag-store-pgvector` | `entities`, `relationships`, `communities` tables with pgvector columns for embeddings; k-hop expansion via recursive CTEs. **Recommended default:** one database for everything. |
| Neo4j | `rag-graph-neo4j` | For teams that already run Neo4j or need deep traversals. Uses Neo4j's vector index for entity search. |

---

## 8. Token-optimization techniques, stage by stage

These carry over from the .NET plan (§6 there), with Node libraries. Each technique is behind an
option, on by default where safe, and **reports what it saved**.

### 8.1 Extraction

| Technique | Detail |
|---|---|
| Structure-preserving Markdown | Keeps headings, lists, tables without HTML/XML overhead. |
| Reading-order reconstruction (PDF) | pdf.js gives text items with positions; we group into lines/columns and reorder multi-column pages. |
| Table compaction | Collapse merged/empty cells; emit Markdown or CSV, whichever is fewer tokens; split very wide tables by row groups with the header repeated. |
| Skip non-content | Images without captions, fonts, form chrome, revision marks, comments (opt-in), hidden text. |
| OCR only when needed | Detect pages with no text layer; send only those pages to the OCR provider. |

### 8.2 Cleaning (`ContentCleaner` chain)

| Cleaner | Removes |
|---|---|
| `repeatedPageArtifactCleaner` | Lines repeating at the top/bottom of ≥ N% of pages (headers, footers, page numbers, banners). |
| `whitespaceUnicodeCleaner` | `String.prototype.normalize('NFKC')`, ligatures, soft hyphens, line-break de-hyphenation, collapsed whitespace, zero-width/invisible characters. |
| `boilerplateCleaner` (HTML) | Nav, footers, cookie banners, scripts/styles via Readability's main-content heuristic. |
| `tocCleaner` | TOC and index pages (dot-leader + page-number pattern). |
| `duplicateBlockCleaner` | Exact duplicate paragraphs within a document. |

### 8.3 Chunking

- Structure-aware first (heading boundaries), size-bounded second (`targetTokens`, never above
  `maxTokens`). Tables and code blocks are never split mid-row/mid-block unless one alone exceeds
  `maxTokens`.
- **Heading-path prefix instead of overlap** (overlap optional, default 0).
- Parent–child (small-to-big); the packer expands to the parent only when the budget allows.
- Exact token counts via the configured tokenizer.
- Spreadsheets chunked by **row groups with a repeated header** and a row cap ("N rows omitted").

### 8.4 De-duplication and incremental ingestion

- Document-level content hash → `unchanged` skips everything (including graph extraction).
- Chunk-level hashes → re-embed (and re-extract graph) only changed chunks; delete vanished chunk
  ids and their graph provenance links.
- Embedding reuse by `(embeddingModelId, chunkContentHash)`, looked up in the vector store
  itself (`findByContentHash`). No new storage dependency.
- Concurrent ingests of one document: last-writer-wins by `documentVersion`; an older version
  returns `stale` and changes nothing.
- Source deletions: `deleteDocument` + a documented reconciliation pattern (caller lists source
  ids; R removes the rest).

### 8.5 Retrieval and packing

| Step | Token impact |
|---|---|
| Hybrid (vector + keyword, RRF) | Only where the store supports it natively (`capabilities.hybrid`); otherwise degrades to vector-only with a one-time warning. Capability matrix in the README. |
| `minScore` threshold | Drops weak matches instead of always returning `topK`. |
| MMR | Requests vectors; capped at ~50 candidates. |
| Rerank → top N | Cross-encoder picks the best few. |
| Budgeted packing | Fill to `maxTokens` minus margin, merge adjacent chunks, expand to parent only if room, drop lowest first; chunks and graph facts share one budget. |
| Ordering | Strongest items at the start and end ("lost in the middle"). |
| Compact citations | `[1]` for chunks, `[G1]` for graph facts, with a separate `citations` array. |
| Extractive compression (optional, no LLM) | Drop sentences with low similarity to the query. |

---

## 9. Standalone service (Goal 2)

### 9.1 Shape

`@promact/rag-server` is a Fastify app that wraps `createRag`. It is published two ways:

- **Docker image:** `ghcr.io/promact/rag-service:<version>` (multi-arch `linux/amd64` +
  `linux/arm64`, non-root user, distroless or `node:22-slim` base, `HEALTHCHECK` built in).
- **npm package with a CLI:** `npx @promact/rag-server --config rag.config.yaml`, for teams that
  run Node but want the service out of process.

Which extractors, stores and models are active is chosen **by configuration**, not code.
The image includes all *open-source* provider packages; cloud ones (Azure DI, Cohere) are
included but inactive until configured.

### 9.2 HTTP API (v1)

Versioned under `/v1`. OpenAPI 3.1 is generated from the route schemas and served at
`/openapi.json` (+ Swagger UI at `/docs`, disabled in production by default).

| Method & path | Purpose |
|---|---|
| `POST /v1/collections` | Create a collection (embedding model, dimensions, graph on/off, entity types). |
| `GET /v1/collections/{name}` | Collection config + stats (documents, chunks, entities, token savings). |
| `POST /v1/collections/{name}/documents` | Ingest. `multipart/form-data` (file + JSON metadata) **or** JSON with a `url` / `fileServiceRef` (S3/Azure via `@promact/file-service`). Returns `202` + `jobId`. `?wait=true` for small files returns the `IngestionResult` directly. |
| `GET /v1/jobs/{jobId}` | Ingestion job status and `IngestionResult`. |
| `DELETE /v1/collections/{name}/documents/{documentId}` | Delete a document (chunks + graph provenance). |
| `POST /v1/collections/{name}/reconcile` | Body: list of current source ids; removes the rest. |
| `POST /v1/collections/{name}/retrieve` | Body: `RetrievalQuery` + `ContextBudget` → `RetrievedContext`. **The main endpoint.** |
| `POST /v1/collections/{name}/search` | Raw scored chunks / graph items, no packing (for callers doing their own packing). |
| `POST /v1/collections/{name}/graph/communities:rebuild` | Trigger community detection + summaries (job). |
| `GET /healthz`, `GET /readyz` | Liveness; readiness checks the vector/graph store and queue. |
| `GET /metrics` | Prometheus metrics (optional; OTLP export is the primary path). |

Errors use RFC 9457 `application/problem+json` with stable `type` codes (`validation`,
`unsupported-content-type`, `document-too-large`, `budget-too-small`, `forbidden`, …).

### 9.3 Identity, tenancy and security

The biggest risk of a shared service is a caller reading another tenant's data by changing a
field in the request body. So **the server never trusts a tenant id or ACL list from the body
by default**:

| Auth mode | Where tenant + ACL groups come from | Use when |
|---|---|---|
| `jwt` (default) | Claims of a validated JWT (OIDC issuer, audience, JWKS). Claim names are configurable (e.g. `tid`, `groups`). | Front-ends or services calling with an end-user token. |
| `trusted-service` | Request body/headers, **only** for callers authenticated with a service API key that has the `trusted` scope. | A backend that already did its own authorization and calls on behalf of users. |
| `none` | Body. Refuses to start unless `RAG_ALLOW_INSECURE=true` and it is bound to localhost. | Local development only. |

Other rules:

- API keys are stored hashed; scopes: `ingest`, `retrieve`, `admin`, `trusted`.
- Upload limits enforced at the HTTP layer **and** the extractor (max body size, max pages,
  zip-bomb limits for OOXML, per-document timeout).
- Rate limiting per API key (`@fastify/rate-limit`).
- CORS off by default.
- No document text in logs; only ids, sizes and token counts.
- Data egress table in the README (which configured providers send content off the box).

### 9.4 Background ingestion

- **Default: in-process queue** with a concurrency limit and a persistent job table in the same
  Postgres. Good for a single replica.
- **Multi-replica: BullMQ on Redis.** `RAG_QUEUE=bullmq`. API replicas and worker replicas can
  scale separately (`rag-server --role api|worker|all`).
- Jobs are idempotent (keyed by `documentId` + `documentVersion`), so retries are safe.
- Graceful shutdown: stop accepting jobs, finish or re-queue in-flight ones on `SIGTERM`.

### 9.5 Configuration

12-factor: environment variables, with an optional YAML file for larger setups (env overrides
file). Validated at startup; the process exits with a clear message on bad config.

```yaml
# rag.config.yaml (sketch)
auth: { mode: jwt, issuer: https://login.example.com/, audience: rag-api, tenantClaim: tid, groupsClaim: groups }
store: { type: pgvector, url: ${DATABASE_URL} }
embeddings: { type: ollama, url: http://ollama:11434, model: nomic-embed-text }
chat: { type: ollama, url: http://ollama:11434, model: llama3.1:8b }    # only needed for graph
extractors: [pdf, office, html, markdown, text]
queue: { type: inprocess, concurrency: 4 }
limits: { maxUploadMb: 50, maxPages: 2000, ingestTimeoutSec: 300 }
telemetry: { otlpEndpoint: http://otel-collector:4318 }
```

### 9.6 Ready-made deployments

Shipped in `packages/rag-server/deploy/`:

- `docker-compose.local.yml` — **all-local, no egress:** rag-service + Postgres/pgvector +
  Ollama (embeddings + chat). One command to try everything, including GraphRAG.
- `docker-compose.cloud.yml` — rag-service + Postgres/pgvector, with OpenAI/Azure OpenAI keys
  from env.
- A Helm chart is **later**, once a real deployment asks for it.

### 9.7 Using it from other frameworks

| Consumer | How |
|---|---|
| Node/TS | `@promact/rag-client` (typed, generated from OpenAPI), or the library directly (Goal 1). |
| .NET, Python, Java, Go… | Generate a client from `/openapi.json` (NSwag/Kiota, openapi-python-client, openapi-generator), or call with plain HTTP. The README shows `curl` and short .NET and Python examples. |
| Browser | Only through the consumer's own backend or with a user JWT (`jwt` mode); never with a service API key. |

This also gives the .NET world a path: a .NET app can use this service today instead of waiting
for the `nuget-packages/rag-service` plan to be built. Whether the .NET native package is still
needed is open question 7 (§16).

---

## 10. Storage schema

### 10.1 Chunk records (vector store)

| Field | Kind | Notes |
|---|---|---|
| `chunkId` | key | Deterministic (§6.2). |
| `documentId` | filterable | Deletes/updates. |
| `tenantId` | filterable | **Always filtered.** |
| `aclGroups` | filterable (string array) | Security trimming. |
| `text` | full-text searchable | Clean Markdown. |
| `headingPath`, `pageStart`, `pageEnd`, `sourceUri`, `contentType` | data | Citations. |
| `contentHash`, `documentVersion` | data | Incremental ingestion. |
| `parentChunkId` | data | Small-to-big. |
| `embeddingModelId` | filterable | Detects stale vectors; side-by-side re-indexing. |
| `embedding` | vector | Dimensions + distance from config. |

### 10.2 Graph records

As in §7.2, with `tenantId` on every row and `sourceChunkIds` on every entity, relationship,
claim and community.

**Embedding-model change policy:** a new model means a new collection (`kb-chunks-v2`),
re-indexed in the background, then the read alias switches. Vectors from different models are
never mixed.

---

## 11. Observability and evaluation

### 11.1 Telemetry

Tracer and meter named `@promact/rag`. Spans per stage: `extract`, `clean`, `chunk`, `embed`,
`upsert`, `graph.extract`, `graph.resolve`, `graph.communities`, `search`, `graph.search`,
`rerank`, `pack`, and in the server, the HTTP span as parent.

Metrics: `rag.ingest.tokens.raw` / `.clean` (the extraction-savings ratio),
`rag.ingest.chunks.embedded` / `.reused`, `rag.graph.llm.tokens.input` / `.output`,
`rag.retrieve.candidates`, `rag.retrieve.context.tokens`, `rag.retrieve.chunks.dropped`,
`rag.retrieve.graph.facts`, latency histograms per stage, and in the server, queue depth and
job durations.

### 11.2 Evaluation harness

- `packages/rag-eval` — **private** workspace package (never published) that runs a golden set
  of `(query, expected document/chunk ids)` against a fixture corpus and reports recall@k, MRR,
  nDCG and **average context tokens per query**.
- Graph-specific golden queries (relationship and global questions), so GraphRAG has to prove
  it helps the questions it is meant for, without hurting the others.
- PR check: runs offline with local ONNX embeddings (`rag-embed-local`) and a **recorded**
  graph extraction fixture (LLM output saved to JSON), so it is deterministic and needs no
  secrets. Report only.
- Nightly: production embedding model + real LLM extraction.
- Parity run (§1): the same golden set through `rag-server` over HTTP must give identical results.

---

## 12. Fit with this repo

- **Toolchain:** same as the other packages: TypeScript strict via `tsconfig.base.json`,
  CommonJS output, Jest + `ts-jest`, ESLint, Node 22+. No real network calls in unit tests;
  SDKs and HTTP are mocked.
- **Coverage:** this repo has no coverage gate today. RAG packages add a Jest `coverageThreshold`
  of **100% lines** per package (matching the .NET repo's bar), excluding `rag-eval` and
  generated client code.
- **Integration tests:** a separate CI job starts Postgres/pgvector (and Qdrant, Neo4j as they
  land) as GitHub Actions service containers. Kept out of `npm test` so local runs need no Docker.
- **`@promact/file-service`:** a `fileServiceSource()` helper in `rag-core` turns an S3/Azure
  object reference into a `DocumentSource` (optional peer dependency; not a hard dependency).
- **`@promact/feature-flag-management`:** consumers can gate rerank/graph rollout with it; no hard
  dependency.
- **CI:** extend `ci.yml` (build/lint/test already cover all workspaces). Add
  `rag-integration.yml` (service containers), and `rag-eval-nightly.yml`.
- **Publishing (npm):** unchanged flow: `publish.yml` stages versions on GitHub Release and a
  maintainer approves on npmjs.com. Each new `@promact/rag-*` package must be published once
  manually and then have its Trusted Publisher set on npmjs.com (owner `Promact`, repo
  `reusable-components-node`, workflow `publish.yml`), as for the existing packages.
- **Publishing (Docker):** new `publish-docker.yml` on the same GitHub Release: build multi-arch,
  push to GHCR with the `GITHUB_TOKEN` (no stored secrets), sign with cosign keyless, and
  attach an SBOM.
- **Versioning:** all `rag-*` packages and the image share one version number, so
  `rag-server 0.3.0` always means "built from `rag-* 0.3.0`".

---

## 13. Handoff to A and G (designed now, built later)

`RetrievedContext` stays the **only** contract A/G need from R, in both forms (the library
returns the object; the server returns it as JSON).

- **A** takes `RetrievedContext` + the user query → prompt messages (delimiting, citation
  instructions, injection defences). Query rewriting (HyDE, multi-query) and LLM-based
  compression plug in later as optional `QueryTransformer` / `ContextCompressor` stages.
- **G** calls a chat model, validates citations (`[n]` and `[G n]` must exist in `citations`),
  and streams. A future `POST /v1/collections/{name}/answer` endpoint belongs to G, not R.
- `graph-global` map-reduce answering over community summaries is part of G.

---

## 14. Delivery phases and action items

Sizes: **S** ≤ 2 days, **M** ≤ 1 week, **L** ≤ 2 weeks. Every item inherits the repo bar in §12.

### M0 — Decisions and baseline

| ID | Item | Size | Done when |
|---|---|---|---|
| NRAG-01 | Answer the open questions in §16. | S | Answers recorded in §16; priorities below adjusted. |
| NRAG-02 | ADR: our own provider interfaces vs adapting Vercel AI SDK / LangChain.js; tokenizer choice; Louvain vs Leiden. | M | ADR merged under `docs/adr/`. |
| NRAG-03 | Verify current versions + licences on npm for every library in §4–§5. | S | Table in the ADR; all permissive. |
| NRAG-04 | Fixture corpus (~30 docs incl. scanned, multi-column, DOCX tables, XLSX, PPTX, HTML) + golden set (~50 queries, including ~10 relationship and ~5 global questions). | M | Committed under `packages/rag-eval/fixtures/`. |
| NRAG-05 | Naive baseline: plain text, fixed 512-char chunks, vector-only top-5. | S | Tokens/query, recall@5, MRR recorded. |

### M1 — Core (Goal 1 starts)

| ID | Item | Size | Done when |
|---|---|---|---|
| NRAG-06 | Scaffold `rag-core` + `rag-eval` workspaces; Jest coverage threshold. | S | Build/test green in CI. |
| NRAG-07 | Models, interfaces, `createRag` factory with eager validation. | M | 100% coverage; API reviewed against §6. |
| NRAG-08 | Token counters (exact + approximate), TXT/Markdown extraction (remark/mdast), Markdown renderer. | M | Round-trip tests; Markdown-vs-CSV table choice by token count. |
| NRAG-09 | Cleaner chain (§8.2 text cleaners). | M | Invisible-text injection fixture neutralized. |
| NRAG-10 | Structure-aware chunker, parent–child, row-group chunking. | M | Property tests: every chunk ≤ `maxTokens`; no mid-row splits. |
| NRAG-11 | In-memory `VectorStore`; ingestion pipeline with incremental logic. | L | Unchanged re-ingest embeds 0 chunks; 1-paragraph edit re-embeds only affected chunks; older version → `stale`. |
| NRAG-12 | Retriever (mandatory filter, threshold, MMR) + context packer + `KnowledgeRetriever`. | L | Output ≤ budget on every eval query; cross-tenant leakage test passes. |

### M2 — Extractors and providers for the MVP

| ID | Item | Size | Done when |
|---|---|---|---|
| NRAG-13 | `rag-extract-pdf` (reading order, tables, OCR-needed flags, artifact cleaner, TOC cleaner). | L | PDF fixtures extract in correct order. |
| NRAG-14 | `rag-extract-office` (DOCX, XLSX, PPTX) + zip-bomb/size/timeout limits. | L | Office fixtures pass; limit tests fail fast. |
| NRAG-15 | `rag-embed-openai`, `rag-embed-local`, Ollama adapters in core. | M | Mocked unit tests; local model runs offline in eval. |
| NRAG-16 | `rag-store-pgvector` (chunks, hybrid via Postgres full-text + RRF in SQL, filters in-query). | L | Integration job green; leakage test passes on Postgres. |
| NRAG-17 | Eval harness + PR report + nightly job; OTel spans/metrics. | M | **recall@5 ≥ baseline at materially fewer tokens/query.** |
| NRAG-18 | **Release v0.1.0** of the MVP packages (README with compiling examples, egress table, capability matrix). | S | Live on npm under `@promact`. |

### M3 — GraphRAG relationship search (library)

| ID | Item | Size | Done when |
|---|---|---|---|
| NRAG-25 | `ChatModel` interface; `rag-llm-openai`, `rag-llm-anthropic`, Ollama chat in core. | M | Mocked tests; JSON-schema output validated. |
| NRAG-26 | `rag-graph`: extraction with hash cache + ingestion token budget; entity resolution. | L | Unchanged re-ingest costs 0 LLM tokens; merge/unmerge tests. |
| NRAG-27 | Graph tables in `rag-store-pgvector` + in-memory graph store; `graph-local` and `mix` modes; triple rendering in packer. | L | Graph golden queries beat vector-only recall; tokens/query reported; ACL leakage tests pass for entities and relations. |
| NRAG-29 | Graph metrics, README graph section (cost, egress, all-local with Ollama). **Release v0.2.0** of the packages. | M | A library sample answers a relationship question with `[G n]` citations using only local models. |

### M4 — Scanned documents (OCR)

Prioritized over the standalone service (§16). OCR runs **only on pages without a text layer**
(flagged by NRAG-13) and on image files, never on whole documents that already have text.

| ID | Item | Size | Done when |
|---|---|---|---|
| NRAG-30 | `OcrProvider` interface in core (`recognize(page image) → elements with confidence`); PDF page rasterization for flagged pages only (pdf.js + `@napi-rs/canvas`, MIT); image inputs (PNG, JPEG, TIFF). | M | Mixed PDF (text + scanned pages): only scanned pages are rasterized; text pages untouched. |
| NRAG-31 | `rag-extract-ocr` — **local** OCR with `tesseract.js` (Apache-2.0), English model bundled for offline use. Default, because all-local is required from v0.1 (§16). | L | Scanned fixtures extract offline; low-confidence words are dropped or flagged rather than embedded as noise. |
| NRAG-32 | `rag-extract-azure-di` — **optional cloud** OCR + layout (Azure Document Intelligence) for better tables and handwriting. Listed in the egress table. | M | Mocked unit tests; scanned-table fixture extracts as a table, not run-on text. |
| NRAG-33 | OCR cleanup + limits: de-skew/rotation detection, per-page timeout, max OCR pages per document, OCR-pages metric. Eval: scanned golden queries. **Release v0.3.0** of the packages. | M | Recall on scanned fixtures within an agreed gap of their text-PDF twins; tokens/query reported. |

### M5 — Standalone service (Goal 2, later stage)

Starts only after v0.3.0, once the library API (including graph modes and OCR) is stable. Until
then, Node apps use the packages directly and .NET apps have no RAG option (the .NET package is
paused, §16).

| ID | Item | Size | Done when |
|---|---|---|---|
| NRAG-19 | `rag-server`: Fastify app, config loader/validator (including graph settings), `/v1` routes for collections, ingest, jobs, retrieve, search, health. | L | Contract tests for every route; OpenAPI generated. |
| NRAG-20 | Auth modes (`jwt`, `trusted-service`, `none`-guarded), API-key scopes, rate limits, problem+json errors. | M | Tests prove a body-supplied `tenantId` is ignored in `jwt` mode. |
| NRAG-21 | In-process queue with Postgres job table; BullMQ option; `--role` split; graceful shutdown. | M | Kill-during-ingest test: job resumes, no duplicate chunks. |
| NRAG-22 | Dockerfile (multi-arch, non-root, healthcheck), compose files (local + cloud), `publish-docker.yml` (GHCR, cosign, SBOM). Image bundles the tesseract English model. | M | `docker compose -f docker-compose.local.yml up` → ingest a text PDF and a scanned PDF → retrieve (including a graph query) works with no internet after image pull. |
| NRAG-23 | `rag-client` generated from OpenAPI; README examples for curl, .NET, Python. | S | Client used by the parity eval run. |
| NRAG-24 | Parity eval: library vs server results identical. **Release v0.4.0** (packages + image). | S | Image on GHCR; packages on npm. |

### M6 — Later (separate minor releases)

Per the decisions in §16:

- **GraphRAG big-picture search (NRAG-28):** communities (Louvain) + ACL-partitioned summaries +
  `graph-global`, plus the rebuild job and endpoint. Done when global golden queries improve
  and ACL leakage tests pass for summaries.
- **More formats:** `rag-extract-html`.
- **More providers:** `rag-rerank-cohere`, local ONNX reranker, `rag-store-qdrant`,
  `rag-store-azure-search`, `rag-graph-neo4j`.
- Helm chart.

**Critical path:** NRAG-01/02/03 → 06 → 07 → 08–10 → 11 → 12 → (13, 14, 15, 16 in parallel)
→ 17 → 18 → 25 → 26 → 27 → 29 → 30 → 31/32 → 33 → 19 → 20/21 → 22 → 23 → 24.
The standalone service (M5) is deliberately sequenced after GraphRAG (M3) and OCR (M4), so the
server is built once against the final library API instead of being reworked when they land.

---

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Owning `VectorStore`/`EmbeddingModel` interfaces (no Node standard) becomes a maintenance burden | Keep them minimal (only what R calls); adapters are thin; ADR records why. |
| PDF quality in JS (pdf.js gives positioned text, not layout) | Hard-case fixtures from day one; reading-order heuristics tested; OCR/layout provider for pages that fail. |
| GraphRAG ingestion cost surprises a team | Opt-in, hash cache, per-collection token budget, cost metrics, cheap default model. |
| Graph leaks data across ACL groups | Provenance-based trimming, ACL-partitioned summaries, dedicated leakage tests. |
| LLM extraction is non-deterministic, so tests flake | Unit tests mock `ChatModel`; eval uses recorded extraction fixtures; nightly measures the real model. |
| Server becomes a second codebase | Server only wires packages; parity eval in CI. |
| Multi-tenant service misconfigured to trust the request body | `jwt` default; `none` refuses non-localhost; `trusted` is an explicit API-key scope. |
| transformers.js / ONNX runtime size and native binaries in Docker | Separate package; image pre-downloads the default local model at build time; arm64 build tested. |
| Token savings silently hurt answer quality | Every optimization measured on tokens **and** recall; no default switched on without both. |
| Tokenizer mismatch across embedding model, LLM and counter | Budget with the target LLM's tokenizer + margin; approximate counter with 15% margin for vendors without a local tokenizer. |

---

## 16. Product decisions (NRAG-01)

Answered by the product owner on 2026-11-09. The rest of this spec already reflects them.

| # | Question | Decision | Effect on the plan |
|---|---|---|---|
| 1 | Which document types matter? | **All of them:** text PDF, Office (DOCX/XLSX/PPTX), scanned docs/images, HTML, Markdown, plain text. | Every format is in scope; none is dropped. |
| 2 | Which formats ship first? | **PDF + Office + Markdown/TXT in v0.1.** Scanned/OCR next after GraphRAG (v0.3, ahead of the standalone service); HTML later. | Matches the MVP in §5 and M2. OCR is M4; `rag-extract-html` is M6. |
| 3 | First vector store? | **Postgres + pgvector.** | One database for vectors, graph and the job table. Qdrant and Azure AI Search move to M6. |
| 4 | All-local / no-egress from v0.1? | **Yes.** | `rag-embed-local` and the Ollama adapters are in the MVP, so the library runs with no internet from v0.1. `docker-compose.local.yml` must do the same once the service ships (v0.4). OCR is local by default (`tesseract.js`) for the same reason. |
| 5 | Multi-tenancy model? | **Shared collection, filtered by tenant.** | Mandatory in-query tenant filter (§10) plus leakage tests. Moving one large tenant to its own collection later is a configuration change. GraphRAG graphs are always per tenant (§7.5). |
| 6 | Languages? | **English only.** | English embedding model, tokenizer and Postgres `english` full-text configuration. Multilingual is a later change. |
| 7 | Typical context budget? | **~4,000 tokens.** | `ContextBudget.maxTokens` defaults to 4000 (callers can override). Chunk defaults stay at 400 target / 600 max tokens. |
| 8 | Still build the .NET NuGet RAG package? | **Paused.** | .NET apps call the standalone service over HTTP (§9.7). Revisit only if a .NET project needs it in-process. |
| 9 | GraphRAG priority? | **Relationship search first; big-picture later.** | `graph-local` and `mix` ship in v0.2 (M3). Community detection, summaries and `graph-global` move to M6. |
| 10 | Hosting? | **Each project self-hosts the Docker image.** | No Promact-run shared instance. Auth modes (§9.3) still ship with the service in v0.4 because a project may serve several of its own tenants, but a shared-instance operations setup (on-call, cross-project monitoring) is out of scope. |
| 11 | When does the standalone service come? | **Later stage, after the library, GraphRAG and scanned-document OCR.** | Order is v0.1 core library → v0.2 GraphRAG relationship search → v0.3 OCR → v0.4 standalone service + Docker image (§14). |
