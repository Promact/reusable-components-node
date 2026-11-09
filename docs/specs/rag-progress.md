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
| [ ] | NRAG-08 | `TokenCounter` (exact + approximate w/ margin), TXT + Markdown extractors → element model, compact Markdown renderer (table as Markdown or CSV, whichever is fewer tokens). | §6.1, §8.1 (l.494–502) |
| [ ] | NRAG-09 | Cleaner chain: `whitespaceUnicodeCleaner`, `duplicateBlockCleaner` (+ stats of what was removed). Include an invisible/zero-width-character injection test. | §8.2 (l.504–512) |
| [ ] | NRAG-10 | Structure-aware token-budgeted chunker: heading-path prefix, never > `maxTokens`, no mid-table/code splits, parent–child, row-group chunking with repeated header. Chunk id = hash(documentId, contentHash, occurrence). | §6.2, §8.3 (l.514–522) |
| [ ] | NRAG-11 | In-memory `VectorStore` + `IngestionPipeline` with incremental logic (doc hash skip, chunk reuse via `findByContentHash`, `documentVersion` last-writer-wins → `stale`, delete). Use a deterministic fake `EmbeddingModel` in tests. | §6.2–6.3, §8.4 (l.524–534), §10.1 |
| [ ] | NRAG-12 | Retriever (mandatory tenant/ACL filter applied inside the store search, `minScore`, MMR) + context packer (budget − margin, default 4000, merge adjacent, parent expansion if room, edge ordering, `[n]` citations) + `KnowledgeRetriever`. Cross-tenant leakage test. | §6.4, §8.5 (l.536–549) |

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

## Blocked / questions for Roshni

_(none yet)_
