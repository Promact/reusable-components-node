# ADR 0001 — rag-core dependencies (M1)

Status: accepted (unattended run 1; verified with `npm view` and a CommonJS `require` smoke test on 2026-11-09).

## Tokenizer: `gpt-tokenizer` 4.1.0 (MIT)

Pure JS, zero runtime dependencies, `require()` works under CommonJS/ts-jest, built-in
`countTokens`. `js-tiktoken` 1.0.21 (MIT) also works but pulls `base64-js` and needs explicit
encoding selection. An approximate counter (chars/4 with safety margin) covers vendors without a
local tokenizer.

## Markdown parser: `mdast-util-from-markdown` 0.8.5 + `micromark-extension-gfm` 0.3.3 + `mdast-util-gfm` 0.1.2 + `@types/mdast` 3.0.15 (all MIT)

`remark-parse`/`unified` >= 10 and current `mdast-util-from-markdown` are ESM-only, but this repo
builds CommonJS and tests with ts-jest (no ESM/`require(esm)` support). The last CJS-compatible
line is the micromark-2 era (mdast-util-from-markdown 0.8.x). Verified it parses headings, lists,
code and GFM tables via `require`, with 0 `npm audit` findings. We skip `unified`/`remark-parse`
(only a thin wrapper over the same parser). Trade-off: older line, no new features; revisit if the
repo moves to ESM. `marked` 18 was rejected (ESM-only, and not an mdast AST).

All licences permissive (MIT). Packages stay `"private": true`.
