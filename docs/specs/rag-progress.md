# RAG build progress

Branch: `feat/rag-core`. Spec: `docs/specs/rag-service-spec.md` (line numbers below are
approximate; search for the heading if they drift). Rules: see `CLAUDE.md`.

Goal of this branch: milestone **M1** (spec §14, NRAG-06 → NRAG-12) in `packages/rag-core`.
Out of scope here: real databases, Docker, PDF/Office extractors, GraphRAG, the server.

## Items

Status: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

| Status | ID | Item | Read in spec |
|---|---|---|---|
| [x] | NRAG-03-lite | Pick and verify deps for M1 only: tokenizer (`gpt-tokenizer` vs `js-tiktoken`), Markdown parser (`remark-parse`/`unified`/`mdast` types). `npm view <pkg> version license`. Record choice + versions + licences in `docs/adr/0001-rag-core-dependencies.md` (short). Note: remark/unified are ESM-only; this repo builds CommonJS — choose a version/approach that works with CommonJS + ts-jest, or a CJS-compatible alternative, and say why. | §4 (l.120–147) |
| [x] | NRAG-06 | Scaffold `packages/rag-core` (copy `file-service` layout), `"private": true`, Jest `coverageThreshold` 100% lines for this package. | §5 (l.149–193), §12 (l.717–743) |
| [x] | NRAG-07 | Models + interfaces (§6.1–6.4) and `createRag` factory skeleton with eager validation (§6.5). Ollama adapters can wait. | §6 (l.195–391) |
| [x] | NRAG-08 | `TokenCounter` (exact + approximate w/ margin), TXT + Markdown extractors → element model, compact Markdown renderer (table as Markdown or CSV, whichever is fewer tokens). | §6.1, §8.1 (l.494–502) |
| [x] | NRAG-09 | Cleaner chain: `whitespaceUnicodeCleaner`, `duplicateBlockCleaner` (+ stats of what was removed). Include an invisible/zero-width-character injection test. | §8.2 (l.504–512) |
| [x] | NRAG-10 | Structure-aware token-budgeted chunker: heading-path prefix, never > `maxTokens`, no mid-table/code splits, parent–child, row-group chunking with repeated header. Chunk id = hash(documentId, contentHash, occurrence). | §6.2, §8.3 (l.514–522) |
| [x] | NRAG-11 | In-memory `VectorStore` + `IngestionPipeline` with incremental logic (doc hash skip, chunk reuse via `findByContentHash`, `documentVersion` last-writer-wins → `stale`, delete). Use a deterministic fake `EmbeddingModel` in tests. | §6.2–6.3, §8.4 (l.524–534), §10.1 |
| [x] | NRAG-12 | Retriever (mandatory tenant/ACL filter applied inside the store search, `minScore`, MMR) + context packer (budget − margin, default 4000, merge adjacent, parent expansion if room, edge ordering, `[n]` citations) + `KnowledgeRetriever`. Cross-tenant leakage test. | §6.4, §8.5 (l.536–549) |

## M2 — extractors and providers for v0.1 (branch `feat/rag-m2`)

M1 is in PR #17 (`feat/rag-core` → master). M2 builds on top of it on `feat/rag-m2`.

| Status | ID | Item | Read in spec |
|---|---|---|---|
| [x] | NRAG-34 | File-based `VectorStore` (`fileVectorStore({ path })`) in rag-core: atomic writes, base64 vectors, single-writer lock. | §10.3 |
| [x] | NRAG-15 | `rag-embed-openai`, `rag-embed-local` (transformers.js), Ollama embedding adapter in core. Mocked tests only. | §4, §5, §6.3 |
| [x] | NRAG-14 | `rag-extract-office` (DOCX, XLSX, PPTX) + zip-bomb/size/timeout limits. | §5, §8.1 |
| [x] | NRAG-13 | `rag-extract-pdf` (reading order, tables, OCR-needed flags, artifact + TOC cleaners). | §5, §8.1 |
| [ ] | NRAG-16 | `rag-store-pgvector` (hybrid via Postgres full-text + RRF, in-query filters, `(tenantId, chunkId)` key). | §10.1 |
| [ ] | NRAG-17 | `packages/rag-eval` (private, never published): small fixture corpus we write ourselves (NRAG-04-lite: ~10 docs across MD/TXT/PDF/DOCX/XLSX/PPTX + ~20 golden queries), naive baseline (NRAG-05: fixed 512-char chunks, vector-only top-5), harness reporting recall@5, MRR, tokens/query with a deterministic fake embedder by default; measure file-store load time/memory at 1k/10k/50k chunks and put the numbers in the rag-core README. No CI workflow changes. | §11.2, §14 M0 |
| [ ] | NRAG-18 | Release v0.1.0 — **human only**. | §14 |

## M2 run plan (cloud routines, off hours IST)

- **Run 1 (Sonnet):** NRAG-15 embeddings.
- **Run 2 (Sonnet):** NRAG-14 Office.
- **Run 3 (Sonnet):** NRAG-13 PDF.
- **Run 4 (Opus):** review NRAG-34/15/14/13 (checklist below), fix, then continue the next item only if clean.
- **Run 5 (Sonnet):** NRAG-16 pgvector (if Postgres can't run in the cloud sandbox: unit tests with a mocked `pg`, integration tests gated on `RAG_PG_URL`, record it under Blocked).
- **Run 6 (Sonnet):** NRAG-17 eval.
- **Run 7 (Opus):** final M2 review, fixes, M2 review summary. Opens nothing on npm; NRAG-18 stays human.

Each run: if its item is already [x], take the next unfinished one. M2 review checklist (adds to the M1 one): extractors
enforce size/zip-bomb/timeout limits and fail fast; no network or model download in unit tests; every adapter keys
records by `(tenantId, chunkId)` and filters tenant/ACL inside the query (SQL `WHERE`, not after); SQL is parameterised;
licences permissive; every new package `"private": true`.

## M1 run plan (done)

- **Run 1 (Sonnet):** NRAG-03-lite, NRAG-06, NRAG-07.
- **Run 2 (Sonnet):** NRAG-08, NRAG-09, NRAG-10; NRAG-11 if the run is still going well.
- **Run 3 (Opus):** review everything on the branch first (see the review checklist), fix
  findings, then continue the next unfinished item only if the review is clean.

Each run: stop after its items, or earlier if blocked. Don't start an `L` item you can't finish.

## Review checklist (run 3)

- Chunk ids are stable when a paragraph is inserted earlier in the document.
- Chunks never exceed `maxTokens`; tables/code never split mid-row/mid-block.
- No public path searches without a tenant filter; filter is applied in the store query, not after.
- Context output never exceeds `maxTokens − margin`.
- Tests assert behaviour (not just "doesn't throw"); no tests weakened or skipped.
- Only permissive licences; package stays `"private": true`.

## Log

Append one short entry per run: date/time, model, items finished, commits, anything notable.

- 2026-11-09, Sonnet 5.5 (run 1): NRAG-03-lite, NRAG-06, NRAG-07 done (commits c9bd8b0, 127a716, 978f0da). Markdown stack pinned to CJS-compatible mdast-util-from-markdown 0.8.5 + GFM 0.x (see ADR 0001). `createRag` ingest/deleteDocument/getContext are stubs until NRAG-11/12; 'embedding dims vs existing collection' check needs async ensureCollection, deferred to NRAG-11. Spec §10 not read: `RetrievalFilter` defined as {tenantId, aclGroups}; verify against §10. gh unauthenticated per CLAUDE.md, so no draft PR opened.

- 2026-11-09, Sonnet 5.5 (run 2): NRAG-08, NRAG-09, NRAG-10, NRAG-11 done (commits 4a1923e, b25046d + lint fix 41c8f0b, 185a2c0, and the NRAG-11 commit). Baseline was green at start. rag-core: 84 tests, 100% line coverage. `createRag.ingest`/`deleteDocument` are now wired (getContext still a stub for NRAG-12). Note: the NRAG-09 commit b25046d was pushed with a lint error (my mistake); fixed in 41c8f0b. See "Blocked / questions" for design decisions.

- 2026-11-09, Opus 5.5 (run 3, review): baseline green (84 tests). Review fixed 3 defects, each with a regression test:
  8dbc985 (cross-tenant record overwrite in the memory store), 27a7366 (chunks above maxTokens for tiny budgets with
  fenced code), 5bd64b5 (same-content version bump not recorded → an older version could win). Then NRAG-12 done
  (f40d908). M1 items all [x]. rag-core: 104 tests, 100% line coverage. No draft PR: gh is not authenticated (CLAUDE.md).

## Blocked / questions for Roshni

No item is blocked. Decisions made unattended that you may want to overrule:

- **`VectorStore.listDocument` added** (not in spec §6.3 sketch). §8.4 (doc-hash skip, vanished-chunk deletion,
  version check) cannot be implemented without listing a document's stored chunks. Returns `ChunkRef`s; must filter by tenant.
- **`findByContentHash` has no tenant parameter** (as in the spec). Vectors are reusable across tenants, which reveals only
  that identical text exists elsewhere (weak existence oracle). Consider adding a tenant scope in the ADR.
- **Parents are stored as records** with `metadata.role = 'parent'` and an empty vector; leaves have `role = 'leaf'`. Stores must
  never rank parents (memory store skips them). NRAG-12's packer needs a way to fetch a parent by id — the `VectorStore`
  interface has no `getByIds` yet; add it in NRAG-12.
- **`overlapTokens > 0` is rejected** by the chunker for now (heading-path prefix is the default; spec says overlap is optional).
- **Same-version re-ingest with identical content is `unchanged`** even if a higher version number arrives (records keep the old
  version number). An equal version with different content is treated as an update. `failed` outcome is never returned: errors throw.
- `duplicateBlockCleaner` defaults to `minChars: 0` (literal spec); zero-width joiners are stripped (hurts Persian/Indic/emoji ZWJ text).
- Unchanged-detection keys on doc hash + chunking/model signature + ACL set; cleaner-chain config changes are not part of the signature.
- **Store record identity is `(tenantId, chunkId)`** (run 3 fix). Chunk ids hash `documentId`, which is only unique per tenant.
  Real adapters (pgvector/Qdrant/…) must use a composite key or include `tenantId` in the stored id. Alternative: put
  `tenantId` into the chunk-id hash (deviates from spec §6.2) — your call.
- **`VectorStore.getByIds(collection, filter, ids)` added** (run 3) for parent expansion; filtered like `search`.
- **A same-content re-ingest with a higher `documentVersion` now re-upserts** the records (vectors reused, no embedding)
  and reports `unchanged`. This replaces the earlier "records keep the old version number" behaviour, which broke
  last-writer-wins.
- **Merged context blocks** share one `[n]` label; `citations` has one entry per chunk with that label. Parent expansion
  cites the parent chunk id. Graph modes (`graph-local`/`graph-global`/`mix`) throw until GraphRAG exists.

- **Embedding model licence unverified** (run M2-1): huggingface.co is blocked in the cloud sandbox, so Apache-2.0 for
  `Xenova/all-MiniLM-L6-v2` is from memory of its model card. Please confirm (alternative: bge-small-en-v1.5, MIT).
  **Resolved 2026-11-17:** verified via the Hugging Face API: both `Xenova/all-MiniLM-L6-v2` and
  `sentence-transformers/all-MiniLM-L6-v2` are tagged `license:apache-2.0`.

## Review summary (run 3, Opus 5.5)

**Checked** (`git diff origin/master...feat/rag-core`, packages/rag-core, against the checklist and spec §6.2–6.4,
§8.3–8.5, §10.1): chunk-id derivation and stability, the `maxTokens` invariant (including adversarially tiny budgets),
table/code splitting, cleaner chain (invisible-char stripping), incremental ingestion (hash skip, reuse, stale, vanished
chunks, ACL change), tenant/ACL filtering in every store path, licences of all 39 runtime deps (all MIT), `"private": true`.

**Defects found and fixed** (one commit each, with a test that failed before the fix):
1. *Security / data loss* — memory store keyed records by `chunkId` only; two tenants ingesting the same `documentId`
   with identical content collided, and the second silently replaced the first tenant's index (an existing test passed
   only because tenant A's data was already gone). Now keyed by `(tenantId, chunkId)`; contract documented on `VectorStore`.
2. *Budget invariant* — with a small `maxTokens`, code was split to single characters but each piece kept its fence,
   producing chunks above `maxTokens`. Fence is dropped when it alone exceeds the budget; the chunker now throws rather
   than emit an over-budget chunk.
3. *Last-writer-wins* — v1 stored, v3 (identical) → `unchanged` without recording v3, then v2 → accepted and overwrote.
   Version bumps are now recorded.

**NRAG-12** implemented after the review was green (retriever, MMR, packer, `KnowledgeRetriever`, cross-tenant test;
packer output is measured on the final rendered text, so it cannot exceed `maxTokens − margin`; property-tested).

**Remaining risks**
- Chunk ids are stable for edits in *other* sections, but inserting a paragraph inside a long section shifts the greedy
  packing boundaries after it, so later chunks in that section get new ids (re-embedded only if their text changed).
- `findByContentHash` is not tenant-scoped (existence oracle across tenants; noted above by run 2).
- Code blocks containing a ``` line can break out of their fence in chunk text (prompt-formatting, not access control).
- Memory store's hybrid score is an average of cosine and keyword overlap, not RRF; real adapters should use native hybrid.
- `aclGroups: []` on a document makes it invisible to everyone (deny by default) — confirm that is intended.

**Look at first:** the `(tenantId, chunkId)` decision (it constrains every real adapter), then `src/packer.ts`
(merge/adjacency rule relies on the chunker's ordinal numbering of parents and leaves).

## M2 log

- 2026-11-16, Opus 5.5 (interactive): spec gets the file-based store (NRAG-34, decision 12). NRAG-34 done: the memory
  store logic moved to `storeCore.ts` (not exported) and is shared by `memoryVectorStore` and `fileVectorStore`.
  19 tests (restart, exact float round-trip, leakage after reload, torn temp file, lock takeover rules, failed writes).
- 2026-11-16, Sonnet 5.5 (run 1): NRAG-15 done. Baseline green (123 tests). `OllamaEmbeddingModel` / `createOllamaEmbeddingModel`
  in rag-core (`/api/embed`, batching, injectable `fetch`); new private packages `rag-embed-openai` (openai 7.57, Apache-2.0;
  OpenAI + Azure, batching, SDK retries honour Retry-After, optional `dimensions`, retry test against a fake fetch) and
  `rag-embed-local` (@huggingface/transformers 4.3.2, Apache-2.0; lazy load, normalised vectors, default
  Xenova/all-MiniLM-L6-v2 384d). All 100% line coverage, no network. Decisions: Ollama/local/OpenAI all need `dimensions`
  (static on the interface); factories are `createOpenAiEmbeddings`, `createLocalEmbeddings`, `createOllamaEmbeddingModel`.
  Model licence for all-MiniLM-L6-v2 (Apache-2.0) could not be verified: sandbox blocks huggingface.co (see Blocked).
- 2026-11-16, Sonnet 5.5 (run 2): NRAG-14 done. Baseline green (151 tests). New private `rag-extract-office` (mammoth 1.13 BSD-2,
  exceljs 4.4 MIT, yauzl 3 + fast-xml-parser 5 MIT; jszip dev-only for fixtures). 174 tests total, 100% line coverage. Limits
  (file size, entries, declared uncompressed total, compression ratio, timeout, AbortSignal) are checked from the zip central
  directory before parsing; tested with crafted zips. Decisions: DOCX goes mammoth -> HTML -> elements; PPTX slides ordered by
  file number (not presentation.xml order) and notes matched by number; sheet heading and slide title are level 1; hidden/empty
  sheets are skipped (counted in `elementsDropped`); PPTX tables/images not extracted; mammoth/exceljs can't be cancelled so
  timeout/abort reject promptly while the parser may finish in the background. Limits are factory options, not `ExtractionOptions`.
- 2026-11-17, Sonnet 5.5 (run 3): NRAG-13 done. Baseline green (174 tests); now 210, 100% line coverage in `rag-extract-pdf`.
  New private package with `createPdfExtractor`, `pdfArtifactCleaner`, `pdfTocCleaner`, `PdfExtractionError`; ADR 0002.
  Decisions: **pdfjs-dist 3.11.174** (Apache-2.0, last line with a CJS build; pinned exactly) over unpdf/ESM-only pdf.js 4+;
  `pdf-lib` (MIT) dev-only for the 6 fixtures (< 5 KB each). pdf.js's `canvas` probe warnings are muted at lazy load. Layout
  is heuristic (see ADR limits: >2 columns, merged-cell tables, rotated/RTL pages not handled). Artifact cleaner only considers
  the first/last two elements of a page so "Step 1" body lines aren't mistaken for page numbers. Image-only pages are flagged
  in `stats.pagesNeedingOcr` but no `image` element is emitted. Encrypted PDFs are rejected (`ENCRYPTED`). Limits are factory
  options (50 MB, 500 pages, 60 s). Newer pdf.js versions have had security fixes; revisit when the repo can go ESM.
