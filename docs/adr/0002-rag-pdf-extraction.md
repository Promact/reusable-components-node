# ADR 0002 — PDF extraction library for `rag-extract-pdf`

Status: accepted (2026-11-17, unattended M2 run 3).

## Decision

Use **`pdfjs-dist@3.11.174`** (Apache-2.0), pinned exactly, loaded from its `legacy/build/pdf.js` CommonJS bundle.
Fixtures are generated with **`pdf-lib@1.17.1`** (MIT), a devDependency only.

## Why

| Option | Licence | CommonJS + ts-jest | Verdict |
|---|---|---|---|
| `pdfjs-dist` ≥ 4 | Apache-2.0 | ESM-only (`.mjs`) — fails under this repo's CJS build/ts-jest | no |
| `pdfjs-dist` 3.11.174 | Apache-2.0 | ships a CJS `legacy/build/pdf.js` with `.d.ts`; worker runs in-process ("fake worker"), verified under ts-jest | **yes** |
| `unpdf` 2.x | MIT | ESM-only wrapper around a bundled pdf.js | no (same problem, plus an extra layer) |

pdf.js exposes positioned text runs (`transform`, `width`) and page geometry, which reading order, column
detection, font-size headings and table detection need; `unpdf`'s text helpers hide them. 3.11.x is the last
line with a CommonJS build. It is older, so the extractor treats PDFs as untrusted: `isEvalSupported: false`,
`disableFontFace: true`, no system fonts, size/page-count/timeout limits, and the pdf.js task is destroyed on
timeout/abort. Revisit when the repo moves to ESM.

## Notes

- pdf.js probes for the optional `canvas` package at load and logs two warnings; we don't need rendering, so the
  module is loaded lazily with `console.log/warn` muted for that one `require`.
- Layout heuristics (reading order, 2-column x-clustering, headings from font size, tables from ≥ 3 aligned
  multi-cell rows) live in `src/layout.ts` and are pure functions over positioned runs, so they are unit-tested
  without PDFs. Known limits: three or more columns, ruled tables with merged cells, rotated pages and
  right-to-left text are not handled specially; scanned pages are only flagged (`stats.pagesNeedingOcr`) for M4.
