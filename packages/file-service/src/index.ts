export * from './types';
export { S3FileService } from './providers/s3';
export { AzureBlobFileService } from './providers/azure-blob';

import { S3FileService } from './providers/s3';
import { AzureBlobFileService } from './providers/azure-blob';
import { S3FileServiceOptions, AzureBlobFileServiceOptions } from './types';

/** Constructs and eagerly validates an S3-backed file service (spec §2.7). */
export function createS3FileService(options: S3FileServiceOptions): S3FileService {
  return new S3FileService(options);
}

/** Constructs and eagerly validates an Azure Blob-backed file service (spec §2.7). */
export function createAzureBlobFileService(options: AzureBlobFileServiceOptions): AzureBlobFileService {
  return new AzureBlobFileService(options);
}
