const mockUploadData = jest.fn();
const mockDownloadToBuffer = jest.fn();
const mockDelete = jest.fn();
const mockExists = jest.fn();
const mockGenerateSasUrl = jest.fn();
const mockListBlobsFlat = jest.fn();

const mockGetBlockBlobClient = jest.fn().mockReturnValue({
  uploadData: mockUploadData,
  downloadToBuffer: mockDownloadToBuffer,
  delete: mockDelete,
  exists: mockExists,
  generateSasUrl: mockGenerateSasUrl,
});

const mockGetContainerClient = jest.fn().mockReturnValue({
  getBlockBlobClient: mockGetBlockBlobClient,
  listBlobsFlat: mockListBlobsFlat,
});

class FakeRestError extends Error {}

jest.mock('@azure/storage-blob', () => ({
  BlobServiceClient: {
    fromConnectionString: jest.fn().mockReturnValue({
      getContainerClient: mockGetContainerClient,
    }),
  },
  BlobSASPermissions: {
    parse: jest.fn().mockReturnValue({ toString: () => 'r' }),
  },
  RestError: FakeRestError,
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('file-bytes')),
}));

import { AzureBlobFileService } from './azure-blob';
import {
  FileServiceConfigError,
  FileModelTypeMismatchError,
  FileServiceValidationError,
  FileNotFoundError,
  AzureFileModel,
} from '../types';

const validOptions = { connectionString: 'DefaultEndpointsProtocol=https;AccountName=x;AccountKey=y' };

function makeModel(overrides: Partial<AzureFileModel> = {}): AzureFileModel {
  return { provider: 'Azure', containerName: 'my-container', keyName: 'my-key', ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AzureBlobFileService construction (spec §2.7, §5)', () => {
  it('rejects a missing connectionString at construction time', () => {
    expect(() => new AzureBlobFileService({ connectionString: '' })).toThrow(FileServiceConfigError);
  });

  it('constructs successfully with a valid connectionString', () => {
    expect(() => new AzureBlobFileService(validOptions)).not.toThrow();
  });
});

describe('AzureBlobFileService validation (spec §2.4, §5)', () => {
  const service = new AzureBlobFileService(validOptions);

  it('rejects a null/missing file model immediately', async () => {
    await expect(service.uploadFile(null as unknown as AzureFileModel)).rejects.toThrow(FileServiceValidationError);
  });

  it('rejects a wrong-shaped model (S3 model handed to Azure adapter)', async () => {
    const s3Model = { provider: 'S3', bucketName: 'b', keyName: 'k' } as unknown as AzureFileModel;
    await expect(service.uploadFile(s3Model)).rejects.toThrow(FileModelTypeMismatchError);
  });
});

describe('AzureBlobFileService.deleteFile / getSignedUrl existence precondition (spec §2.4, §5)', () => {
  const service = new AzureBlobFileService(validOptions);

  it('deleteFile rejects with a "does not exist" error and never calls delete() when the blob is missing', async () => {
    mockExists.mockResolvedValueOnce(false);

    await expect(service.deleteFile(makeModel())).rejects.toThrow(FileNotFoundError);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deleteFile calls delete() when the blob exists', async () => {
    mockExists.mockResolvedValueOnce(true);
    mockDelete.mockResolvedValueOnce(undefined);

    await expect(service.deleteFile(makeModel())).resolves.toBeUndefined();
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('getSignedUrl rejects with a "does not exist" error and never generates a SAS URL when the blob is missing', async () => {
    mockExists.mockResolvedValueOnce(false);

    await expect(service.getSignedUrl(makeModel(), 60)).rejects.toThrow(FileNotFoundError);
    expect(mockGenerateSasUrl).not.toHaveBeenCalled();
  });

  it('getSignedUrl returns a URL when the blob exists', async () => {
    mockExists.mockResolvedValueOnce(true);
    mockGenerateSasUrl.mockResolvedValueOnce('https://example.blob.core.windows.net/signed');

    const url = await service.getSignedUrl(makeModel(), 60);
    expect(url).toBe('https://example.blob.core.windows.net/signed');
  });
});

describe('AzureBlobFileService.uploadFile / getFileAsBytes do not pre-check existence (spec §2.4, §5)', () => {
  const service = new AzureBlobFileService(validOptions);

  it('uploadFile overwrites without checking existence first', async () => {
    mockUploadData.mockResolvedValueOnce(undefined);

    await service.uploadFile(makeModel({ filePath: '/tmp/whatever.txt' }));
    expect(mockExists).not.toHaveBeenCalled();
    expect(mockUploadData).toHaveBeenCalledTimes(1);
  });

  it('getFileAsBytes propagates a raw "not found" error from the provider without an extra existence check', async () => {
    const notFound = new Error('BlobNotFound');
    mockDownloadToBuffer.mockRejectedValueOnce(notFound);

    await expect(service.getFileAsBytes(makeModel())).rejects.toBe(notFound);
    expect(mockExists).not.toHaveBeenCalled();
  });

  it('wraps an unexpected uploadFile failure with descriptive context, preserving the original as cause', async () => {
    const original = new Error('network blip');
    mockUploadData.mockRejectedValueOnce(original);

    await expect(service.uploadFile(makeModel({ filePath: '/tmp/whatever.txt' }))).rejects.toMatchObject({
      message: expect.stringContaining('Error uploading file to Azure Blob Storage'),
      cause: original,
    });
  });
});

describe('AzureBlobFileService.getKeys pagination and error wrapping (spec §2.3, §2.4, §2.6, §5)', () => {
  const service = new AzureBlobFileService(validOptions);

  it('rejects pageNumber <= 0 before any provider call', async () => {
    await expect(
      service.getKeys({ bucketOrContainer: 'c', pageNumber: 0, pageSize: 2 }),
    ).rejects.toThrow(FileServiceValidationError);
    expect(mockListBlobsFlat).not.toHaveBeenCalled();
  });

  it('rejects pageSize <= 0 before any provider call', async () => {
    await expect(
      service.getKeys({ bucketOrContainer: 'c', pageNumber: 1, pageSize: 0 }),
    ).rejects.toThrow(FileServiceValidationError);
    expect(mockListBlobsFlat).not.toHaveBeenCalled();
  });

  it('walks and skips to compute the requested page (spec §2.3)', async () => {
    mockListBlobsFlat.mockReturnValueOnce(
      (async function* () {
        yield { name: 'a' };
        yield { name: 'b' };
        yield { name: 'c' };
        yield { name: 'd' };
      })(),
    );

    const keys = await service.getKeys({ bucketOrContainer: 'c', pageNumber: 2, pageSize: 2 });
    expect(keys).toEqual(['c', 'd']);
  });

  it('wraps an unexpected listing failure in a generic "retrieving keys" error, preserving the original as cause', async () => {
    const original = new Error('boom');
    mockListBlobsFlat.mockReturnValueOnce(
      // eslint-disable-next-line require-yield -- test double only needs to throw, never yield
      (async function* () {
        throw original;
      })(),
    );

    await expect(
      service.getKeys({ bucketOrContainer: 'c', pageNumber: 1, pageSize: 2 }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('error occurred while retrieving keys'),
      cause: original,
    });
  });

  it('lets a typed provider RestError pass through unwrapped', async () => {
    const restError = new FakeRestError('container not found');
    mockListBlobsFlat.mockReturnValueOnce(
      // eslint-disable-next-line require-yield -- test double only needs to throw, never yield
      (async function* () {
        throw restError;
      })(),
    );

    await expect(
      service.getKeys({ bucketOrContainer: 'c', pageNumber: 1, pageSize: 2 }),
    ).rejects.toBe(restError);
  });
});
