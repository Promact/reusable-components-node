# RAG build progress (M1 — core library)

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

## Run plan

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
