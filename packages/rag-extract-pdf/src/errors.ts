export type PdfErrorCode =
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_PAGES'
  | 'INVALID_PDF'
  | 'ENCRYPTED'
  | 'UNSUPPORTED_TYPE'
  | 'TIMEOUT'
  | 'ABORTED';

/** Typed failure; `code` is stable and safe to branch on. */
export class PdfExtractionError extends Error {
  constructor(readonly code: PdfErrorCode, message: string) {
    super(message);
    this.name = 'PdfExtractionError';
  }
}
