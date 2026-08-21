/**
 * Provider-agnostic file storage interface, parameterized by the concrete
 * file-model shape so that a mismatched provider model is a compile-time
 * error (spec §0, §2.1, §2.2, §2.4).
 */
export interface IFileService<TFileModel extends FileModelBase> {
  uploadFile(model: TFileModel): Promise<void>;
  getFileAsBytes(model: TFileModel): Promise<Buffer>;
  deleteFile(model: TFileModel): Promise<void>;
  getSignedUrl(model: TFileModel, expiresInSeconds: number): Promise<string>;
  getKeys(request: GetAllKeysRequest): Promise<string[]>;
  checkFileExists(model: TFileModel): Promise<boolean>;
}

/** Base fields shared by every provider's file model (spec §2.2). */
export interface FileModelBase {
  /** Local filesystem path to the source file. Required for uploadFile only. */
  filePath?: string;
  /** Object key (S3) / blob name (Azure) within the bucket/container. */
  keyName: string;
}

/** File model for the AWS S3 provider (spec §2.2). */
export interface S3FileModel extends FileModelBase {
  provider: 'S3';
  bucketName: string;
}

/** File model for the Azure Blob Storage provider (spec §2.2). */
export interface AzureFileModel extends FileModelBase {
  provider: 'Azure';
  containerName: string;
}

/** Request shape for paginated key/blob-name listing (spec §2.2). */
export interface GetAllKeysRequest {
  bucketOrContainer: string;
  /** 1-based page index. Must be > 0. */
  pageNumber: number;
  /** Max number of keys to return in this page. Must be > 0. */
  pageSize: number;
}

/** Construction options for the AWS S3 provider (spec §2.5). */
export interface S3FileServiceOptions {
  accessKey: string;
  secretKey: string;
  region: string;
}

/** Construction options for the Azure Blob Storage provider (spec §2.5). */
export interface AzureBlobFileServiceOptions {
  connectionString: string;
}

/** Set of AWS region codes recognized as valid at construction time. */
export const VALID_AWS_REGIONS = new Set([
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'af-south-1',
  'ap-east-1', 'ap-south-1', 'ap-south-2',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
  'ca-central-1', 'ca-west-1',
  'eu-central-1', 'eu-central-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3',
  'eu-north-1', 'eu-south-1', 'eu-south-2',
  'il-central-1',
  'me-south-1', 'me-central-1',
  'sa-east-1',
]);

export class FileServiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileServiceConfigError';
  }
}

export class FileModelTypeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileModelTypeMismatchError';
  }
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileNotFoundError';
  }
}

export class FileServiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileServiceValidationError';
  }
}

export class FileServiceOperationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FileServiceOperationError';
  }
}

/** Validates request-level preconditions common to every operation (spec §2.4). */
export function assertValidModel<T extends FileModelBase>(
  model: T | null | undefined,
  provider: 'S3' | 'Azure',
): asserts model is T {
  if (model == null) {
    throw new FileServiceValidationError('File model is required but was null or undefined.');
  }
  const actualProvider = (model as { provider?: string }).provider;
  if (actualProvider !== provider) {
    throw new FileModelTypeMismatchError(
      `Expected a ${provider} file model but received a model for provider "${String(actualProvider)}".`,
    );
  }
  if (provider === 'S3' && typeof (model as unknown as S3FileModel).bucketName !== 'string') {
    throw new FileModelTypeMismatchError('S3 file model is missing required string field "bucketName".');
  }
  if (provider === 'Azure' && typeof (model as unknown as AzureFileModel).containerName !== 'string') {
    throw new FileModelTypeMismatchError('Azure file model is missing required string field "containerName".');
  }
}

export function assertValidGetAllKeysRequest(request: GetAllKeysRequest | null | undefined): asserts request is GetAllKeysRequest {
  if (request == null) {
    throw new FileServiceValidationError('GetAllKeysRequest is required but was null or undefined.');
  }
  if (request.bucketOrContainer == null || request.bucketOrContainer === '') {
    throw new FileServiceValidationError('GetAllKeysRequest.bucketOrContainer is required.');
  }
  if (!(request.pageNumber > 0)) {
    throw new FileServiceValidationError(`pageNumber must be > 0, received ${request.pageNumber}.`);
  }
  if (!(request.pageSize > 0)) {
    throw new FileServiceValidationError(`pageSize must be > 0, received ${request.pageSize}.`);
  }
}
