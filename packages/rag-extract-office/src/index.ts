import { createHash } from 'crypto';
import { DocumentElement, DocumentExtractor, DocumentSource, exactTokenCounter } from '@promact/rag-core';
import { OfficeExtractionError } from './errors';
import { DEFAULT_LIMITS, guardZip, OfficeLimits, verifyEntries } from './zipGuard';
import { extractDocx } from './docx';
import { extractXlsx } from './xlsx';
import { extractPptx } from './pptx';

export { OfficeExtractionError, OfficeErrorCode } from './errors';
export { OfficeLimits, DEFAULT_LIMITS } from './zipGuard';

export interface OfficeExtractorOptions {
  limits?: Partial<OfficeLimits>;
  /** Include PPTX speaker notes as paragraphs (default false). */
  includeSpeakerNotes?: boolean;
}

type Kind = 'docx' | 'xlsx' | 'pptx';
const TYPES: Record<string, Kind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
const EXTS: Record<string, Kind> = { docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };

function kindOf(contentType: string, fileName?: string): Kind | undefined {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (TYPES[ct]) return TYPES[ct];
  if (ct === '' || ct === 'application/octet-stream') return EXTS[(fileName ?? '').toLowerCase().split('.').pop() ?? ''];
  return undefined;
}

async function readLimited(content: DocumentSource['content'], max: number): Promise<Buffer> {
  if (Buffer.isBuffer(content)) {
    if (content.length > max) throw new OfficeExtractionError('FILE_TOO_LARGE', `File is ${content.length} bytes (max ${max})`);
    return content;
  }
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of content as AsyncIterable<Buffer | string>) {
    const b = typeof c === 'string' ? Buffer.from(c) : c;
    n += b.length;
    if (n > max) {
      (content as { destroy?: () => void }).destroy?.();
      throw new OfficeExtractionError('FILE_TOO_LARGE', `File exceeds ${max} bytes`);
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

export function createOfficeExtractor(options: OfficeExtractorOptions = {}): DocumentExtractor {
  const limits: OfficeLimits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [k, v] of Object.entries(limits)) {
    if (!(v > 0)) throw new Error(`rag-extract-office: limit ${k} must be a positive number`);
  }

  return {
    canExtract: (contentType, fileName) => kindOf(contentType, fileName) !== undefined,

    async extract(source, extractOptions, signal) {
      const kind = kindOf(source.contentType, source.fileName);
      if (!kind) throw new OfficeExtractionError('UNSUPPORTED_TYPE', `Unsupported content type ${source.contentType}`);

      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), limits.timeoutMs);
      const check = () => {
        if (signal?.aborted) throw new OfficeExtractionError('ABORTED', 'Extraction aborted');
        if (timeout.signal.aborted) throw new OfficeExtractionError('TIMEOUT', `Extraction exceeded ${limits.timeoutMs} ms`);
      };
      // Third-party parsers cannot be cancelled, so race them: the caller gets the typed error promptly.
      let detach = (): void => undefined;
      const interrupted = new Promise<never>((_, reject) => {
        const fire = () => { try { check(); } catch (e) { reject(e); } };
        timeout.signal.addEventListener('abort', fire);
        signal?.addEventListener('abort', fire);
        detach = () => signal?.removeEventListener('abort', fire);
      });
      interrupted.catch(() => undefined);

      const run = async () => {
        check();
        const raw = await readLimited(source.content, limits.maxFileBytes);
        check();
        // Archive limits are checked from the central directory BEFORE any parser inflates content.
        const { zip, entries } = await guardZip(raw, limits);
        try {
          check();
          // DOCX/XLSX parsers unzip the raw buffer themselves; prove the declared sizes first (PPTX is read via yauzl).
          if (kind !== 'pptx') await verifyEntries(zip, entries, check);
          let elements: DocumentElement[];
          let dropped = 0;
          let pages: number | undefined;
          if (kind === 'docx') elements = await extractDocx(raw);
          else if (kind === 'xlsx') ({ elements, dropped } = await extractXlsx(raw));
          else {
            const r = await extractPptx(zip, entries, options.includeSpeakerNotes ?? false, check);
            elements = r.elements;
            pages = r.slides;
          }
          check();
          return { raw, elements, dropped, pages };
        } finally {
          zip.close();
        }
      };

      try {
        const { raw, elements, dropped, pages } = await Promise.race([run(), interrupted]);
        const counter = extractOptions.tokenCounter ?? exactTokenCounter();
        const plain = elements.map(plainText).join('\n');
        return {
          documentId: source.documentId,
          contentHash: createHash('sha256').update(raw).digest('hex'),
          elements,
          stats: { rawChars: plain.length, rawTokens: counter.count(plain), pages, elementsDropped: dropped, pagesNeedingOcr: [] },
        };
      } finally {
        clearTimeout(timer);
        detach(); // callers often reuse one long-lived signal; don't leak a listener per document
      }
    },
  };
}
