import { createHash } from 'crypto';
import { DocumentElement, DocumentExtractor, DocumentSource, exactTokenCounter } from '@promact/rag-core';
import type * as PdfJs from 'pdfjs-dist/legacy/build/pdf.js';
import { PdfExtractionError } from './errors';
import { layoutDocument, PageInput, TextRun } from './layout';

export { PdfExtractionError, PdfErrorCode } from './errors';
export { pdfArtifactCleaner, pdfTocCleaner, ArtifactCleanerOptions } from './cleaners';

let pdfjsModule: typeof PdfJs | undefined;

/** pdf.js is CommonJS in its `legacy` build. Its optional `canvas` polyfill probe logs noisy warnings at load; they are irrelevant for text extraction. */
function loadPdfjs(): typeof PdfJs {
  if (!pdfjsModule) {
    const { log, warn } = console;
    console.log = console.warn = () => undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      pdfjsModule = require('pdfjs-dist/legacy/build/pdf.js') as typeof PdfJs;
    } finally {
      console.log = log;
      console.warn = warn;
    }
  }
  return pdfjsModule;
}

export interface PdfLimits {
  maxFileBytes: number;
  maxPages: number;
  timeoutMs: number;
}

export const DEFAULT_LIMITS: PdfLimits = { maxFileBytes: 50 * 2 ** 20, maxPages: 500, timeoutMs: 60_000 };

export interface PdfExtractorOptions {
  limits?: Partial<PdfLimits>;
  /** Pages with fewer non-space characters are listed in `stats.pagesNeedingOcr` (default 25). */
  minCharsPerPage?: number;
}

async function readLimited(content: DocumentSource['content'], max: number): Promise<Buffer> {
  if (Buffer.isBuffer(content)) {
    if (content.length > max) throw new PdfExtractionError('FILE_TOO_LARGE', `File is ${content.length} bytes (max ${max})`);
    return content;
  }
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of content as AsyncIterable<Buffer | string>) {
    const b = typeof c === 'string' ? Buffer.from(c) : c;
    n += b.length;
    if (n > max) {
      (content as { destroy?: () => void }).destroy?.();
      throw new PdfExtractionError('FILE_TOO_LARGE', `File exceeds ${max} bytes`);
    }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

function plainText(e: DocumentElement): string {
  if (e.kind === 'list') return e.items.join('\n');
  if (e.kind === 'table') return [e.header, ...e.rows].map((r) => r.join('\t')).join('\n');
  return e.kind === 'image' ? e.caption ?? '' : e.text;
}

function isPdf(contentType: string, fileName?: string): boolean {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct === 'application/pdf') return true;
  return (ct === '' || ct === 'application/octet-stream') && (fileName ?? '').toLowerCase().endsWith('.pdf');
}

export function createPdfExtractor(options: PdfExtractorOptions = {}): DocumentExtractor {
  const limits: PdfLimits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [k, v] of Object.entries(limits)) {
    if (!(v > 0)) throw new Error(`rag-extract-pdf: limit ${k} must be a positive number`);
  }
  const minCharsPerPage = options.minCharsPerPage ?? 25;
  if (!(minCharsPerPage >= 0)) throw new Error('rag-extract-pdf: minCharsPerPage must be >= 0');

  return {
    canExtract: isPdf,

    async extract(source, extractOptions, signal) {
      if (!isPdf(source.contentType, source.fileName)) {
        throw new PdfExtractionError('UNSUPPORTED_TYPE', `Unsupported content type ${source.contentType}`);
      }
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), limits.timeoutMs);
      const check = () => {
        if (signal?.aborted) throw new PdfExtractionError('ABORTED', 'Extraction aborted');
        if (timeout.signal.aborted) throw new PdfExtractionError('TIMEOUT', `Extraction exceeded ${limits.timeoutMs} ms`);
      };
      let task: { destroy(): Promise<void> } | undefined;
      const interrupted = new Promise<never>((_, reject) => {
        const fire = () => {
          try {
            check();
          } catch (e) {
            reject(e);
          }
        };
        timeout.signal.addEventListener('abort', fire);
        signal?.addEventListener('abort', fire);
      });
      interrupted.catch(() => undefined);

      const run = async () => {
        check();
        const raw = await readLimited(source.content, limits.maxFileBytes);
        check();
        const loading = loadPdfjs().getDocument({
          data: new Uint8Array(raw), // copy: pdf.js may take ownership of the buffer
          isEvalSupported: false,
          disableFontFace: true,
          useSystemFonts: false,
          verbosity: 0,
        });
        task = loading;
        const pdf = await loading.promise.catch((e: { name?: string; message?: string }) => {
          if (e?.name === 'PasswordException') throw new PdfExtractionError('ENCRYPTED', 'PDF is password protected');
          throw new PdfExtractionError('INVALID_PDF', `Cannot read PDF: ${e?.message ?? 'unknown error'}`);
        });
        if (pdf.numPages > limits.maxPages) {
          throw new PdfExtractionError('TOO_MANY_PAGES', `PDF has ${pdf.numPages} pages (max ${limits.maxPages})`);
        }
        const pages: PageInput[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          check();
          const page = await pdf.getPage(n);
          const view = page.view as number[];
          const content = await page.getTextContent();
          const runs: TextRun[] = [];
          for (const item of content.items) {
            if (!('str' in item)) continue;
            const [a, b, , , x, y] = item.transform as number[];
            runs.push({ str: item.str, x, y, width: item.width, size: Math.hypot(a, b) });
          }
          pages.push({ page: n, width: view[2] - view[0], height: view[3] - view[1], runs });
          page.cleanup();
        }
        check();
        return { raw, pages };
      };

      try {
        const { raw, pages } = await Promise.race([run(), interrupted]);
        const { elements, pagesNeedingOcr } = layoutDocument(pages, { minCharsPerPage });
        const counter = extractOptions.tokenCounter ?? exactTokenCounter();
        const plain = elements.map(plainText).join('\n');
        return {
          documentId: source.documentId,
          contentHash: createHash('sha256').update(raw).digest('hex'),
          elements,
          stats: { rawChars: plain.length, rawTokens: counter.count(plain), pages: pages.length, elementsDropped: 0, pagesNeedingOcr },
        };
      } finally {
        clearTimeout(timer);
        void task?.destroy().catch(() => undefined);
      }
    },
  };
}
