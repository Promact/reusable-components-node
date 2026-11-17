import yauzl from 'yauzl';
import { OfficeExtractionError } from './errors';

export interface OfficeLimits {
  /** Max size of the file as received (bytes). Default 25 MB. */
  maxFileBytes: number;
  /** Max sum of declared uncompressed entry sizes (bytes). Default 200 MB. */
  maxUncompressedBytes: number;
  /** Max total uncompressed / file size. Default 100. */
  maxCompressionRatio: number;
  /** Max number of zip entries. Default 2000. */
  maxEntries: number;
  /** Wall-clock timeout for one extraction (ms). Default 30 s. */
  timeoutMs: number;
}

export const DEFAULT_LIMITS: OfficeLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxEntries: 2000,
  timeoutMs: 30_000,
};

export function openZip(buf: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // validateEntrySizes makes yauzl error if an entry inflates to a size other than the declared one,
    // so the declared sizes checked below cannot be lied about.
    yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) reject(new OfficeExtractionError('INVALID_ARCHIVE', `Not a valid OOXML zip: ${err?.message ?? 'unknown'}`));
      else resolve(zip);
    });
  });
}

/** Lists entries and enforces archive limits from the central directory only; nothing is inflated. */
export async function guardZip(buf: Buffer, limits: OfficeLimits): Promise<{ zip: yauzl.ZipFile; entries: Map<string, yauzl.Entry> }> {
  const zip = await openZip(buf);
  if (zip.entryCount > limits.maxEntries) {
    zip.close();
    throw new OfficeExtractionError('TOO_MANY_ENTRIES', `Archive has ${zip.entryCount} entries (max ${limits.maxEntries})`);
  }
  const entries = new Map<string, yauzl.Entry>();
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', (e) => reject(new OfficeExtractionError('INVALID_ARCHIVE', `Corrupt zip: ${e.message}`)));
      zip.on('end', resolve);
      zip.on('entry', (e: yauzl.Entry) => {
        total += e.uncompressedSize;
        if (total > limits.maxUncompressedBytes) {
          return reject(new OfficeExtractionError('UNCOMPRESSED_TOO_LARGE', `Uncompressed size exceeds ${limits.maxUncompressedBytes} bytes`));
        }
        if (total / Math.max(buf.length, 1) > limits.maxCompressionRatio) {
          return reject(new OfficeExtractionError('COMPRESSION_RATIO', `Compression ratio exceeds ${limits.maxCompressionRatio}`));
        }
        entries.set(e.fileName, e);
        zip.readEntry();
      });
      zip.readEntry();
    });
  } catch (e) {
    zip.close();
    throw e;
  }
  return { zip, entries };
}

/** Inflates one entry. yauzl (validateEntrySizes) aborts if it inflates past the size declared in the directory, which guardZip already bounded. */
export function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(new OfficeExtractionError('INVALID_ARCHIVE', `Cannot read ${entry.fileName}: ${err?.message}`));
      const parts: Buffer[] = [];
      stream.on('data', (c: Buffer) => parts.push(c));
      stream.on('end', () => resolve(Buffer.concat(parts)));
      stream.on('error', (e) => reject(new OfficeExtractionError('INVALID_ARCHIVE', `Corrupt entry ${entry.fileName}: ${e.message}`)));
    });
  });
}

/**
 * Inflates every entry and discards the bytes, so an entry whose deflate stream is larger than its declared size fails
 * here (yauzl validateEntrySizes) instead of inside a third-party parser. Needed before handing the buffer to parsers
 * that unzip on their own (mammoth and exceljs use JSZip, which trusts the deflate stream, not the declared sizes).
 */
export async function verifyEntries(zip: yauzl.ZipFile, entries: Map<string, yauzl.Entry>, check: () => void): Promise<void> {
  for (const entry of entries.values()) {
    check();
    await new Promise<void>((resolve, reject) => {
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(new OfficeExtractionError('INVALID_ARCHIVE', `Cannot read ${entry.fileName}: ${err?.message}`));
        stream.on('data', () => undefined);
        stream.on('end', resolve);
        stream.on('error', (e) => reject(new OfficeExtractionError('INVALID_ARCHIVE', `Corrupt entry ${entry.fileName}: ${e.message}`)));
      });
    });
  }
}
