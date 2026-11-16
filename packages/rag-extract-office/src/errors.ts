export type OfficeErrorCode =
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_ENTRIES'
  | 'UNCOMPRESSED_TOO_LARGE'
  | 'COMPRESSION_RATIO'
  | 'INVALID_ARCHIVE'
  | 'UNSUPPORTED_TYPE'
  | 'TIMEOUT'
  | 'ABORTED';

/** Typed failure; `code` is stable and safe to branch on. */
export class OfficeExtractionError extends Error {
  constructor(readonly code: OfficeErrorCode, message: string) {
    super(message);
    this.name = 'OfficeExtractionError';
  }
}
