# @promact/rag-extract-office

DOCX, XLSX and PPTX `DocumentExtractor` for `@promact/rag-core` (private, not published).

```ts
import { createOfficeExtractor } from '@promact/rag-extract-office';
const extractor = createOfficeExtractor({ includeSpeakerNotes: false, limits: { maxFileBytes: 10 * 2 ** 20 } });
```

| Format | Library | Output |
|---|---|---|
| DOCX | `mammoth` (BSD-2) | headings, paragraphs, lists, tables (first row = header); comments/revisions dropped |
| XLSX | `exceljs` (MIT) | per visible non-empty sheet: heading (sheet name, level 1) + one table, first non-empty row = header |
| PPTX | `yauzl` + `fast-xml-parser` (MIT) | per slide: heading (title placeholder, else `Slide N`, level 1) + text paragraphs, `page` = slide number; notes opt-in |

## Limits (all checked before any content is parsed)

Defaults in `DEFAULT_LIMITS`; failures throw `OfficeExtractionError` with a stable `code`:
`FILE_TOO_LARGE` (25 MB, also enforced while streaming), `TOO_MANY_ENTRIES` (2000),
`UNCOMPRESSED_TOO_LARGE` (200 MB declared total), `COMPRESSION_RATIO` (100x), `INVALID_ARCHIVE`
(yauzl rejects entries whose real size differs from the declared one, so declared sizes can't be faked),
`TIMEOUT` (30 s), `ABORTED` (`AbortSignal`), `UNSUPPORTED_TYPE`.
mammoth/exceljs cannot be cancelled mid-parse; the call rejects promptly but the parser may finish in the background.

Fixtures: `npm run fixtures -w @promact/rag-extract-office` regenerates `fixtures/*` (< 10 KB each) from text in the script.
Not extracted: PPTX tables/charts/images, DOCX images, XLSX formulas (cached values are used).
