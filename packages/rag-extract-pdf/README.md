# @promact/rag-extract-pdf

PDF `DocumentExtractor` for `@promact/rag-core` (private, not published). Library choice: see `docs/adr/0002-rag-pdf-extraction.md`.

```ts
import { createPdfExtractor, pdfArtifactCleaner, pdfTocCleaner } from '@promact/rag-extract-pdf';
import { cleanerChain, whitespaceUnicodeCleaner } from '@promact/rag-core';

const extractor = createPdfExtractor({ limits: { maxPages: 300 }, minCharsPerPage: 25 });
const cleaners = cleanerChain([pdfArtifactCleaner(), pdfTocCleaner(), whitespaceUnicodeCleaner()]);
```

## What it does

- Groups text runs into lines, reads **2-column** pages column by column (x-clustering; full-width lines act as separators).
- **Headings** from font size relative to the body size (largest = level 1, up to 6); bullet/numbered lines become lists.
- **Tables**: ≥ 3 consecutive lines with the same number of x-aligned cells (first row = header).
- Every element carries its 1-based `page`. Header/footer-band lines are emitted as their own paragraphs.
- Pages with fewer than `minCharsPerPage` (25) non-space characters are listed in `stats.pagesNeedingOcr` (OCR itself is M4).
- `pdfArtifactCleaner()` drops single-line text at the top/bottom of pages that repeats (ignoring digits) on ≥ 3 pages and ≥ 50% of pages.
  `pdfTocCleaner()` drops dot-leader contents blocks and their "Contents" heading. Both record `charsRemoved`/`elementsRemoved` in `doc.cleaning`.

## Limits

`FILE_TOO_LARGE` (50 MB, also enforced while streaming), `TOO_MANY_PAGES` (500, checked before any page is read),
`TIMEOUT` (60 s), `ABORTED` (`AbortSignal`, checked between pages; the pdf.js task is destroyed), `INVALID_PDF`,
`ENCRYPTED` (password-protected PDFs are rejected), `UNSUPPORTED_TYPE`. All throw `PdfExtractionError` with a stable `code`.

Fixtures: `npm run fixtures -w @promact/rag-extract-pdf` regenerates `fixtures/*.pdf` (< 5 KB each) with `pdf-lib` from text in the script.
