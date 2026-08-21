const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://example-bucket.s3.amazonaws.com/signed'),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('file-bytes')),
}));

import {
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presignS3Url } from '@aws-sdk/s3-request-presigner';
import { S3FileService } from './s3';
import {
  FileServiceConfigError,
  FileModelTypeMismatchError,
  FileServiceValidationError,
  FileNotFoundError,
  S3FileModel,
} from '../types';

const validOptions = { accessKey: 'AK', secretKey: 'SK', region: 'us-east-1' };

function makeModel(overrides: Partial<S3FileModel> = {}): S3FileModel {
  return { provider: 'S3', bucketName: 'my-bucket', keyName: 'my-key', ...overrides };
}

describe('S3FileService construction (spec §2.7, §5)', () => {
  it('rejects missing accessKey at construction time', () => {
    expect(() => new S3FileService({ ...validOptions, accessKey: '' })).toThrow(FileServiceConfigError);
  });

  it('rejects missing secretKey at construction time', () => {
    expect(() => new S3FileService({ ...validOptions, secretKey: '' })).toThrow(FileServiceConfigError);
  });

  it('rejects missing/invalid region at construction time', () => {
    expect(() => new S3FileService({ ...validOptions, region: 'not-a-region' })).toThrow(FileServiceConfigError);
    expect(() => new S3FileService({ ...validOptions, region: '' })).toThrow(FileServiceConfigError);
  });

  it('constructs successfully with valid options', () => {
    expect(() => new S3FileService(validOptions)).not.toThrow();
  });
});

describe('S3FileService validation (spec §2.4, §5)', () => {
  const service = new S3FileService(validOptions);

  it('rejects a null/missing file model immediately', async () => {
    await expect(service.uploadFile(null as unknown as S3FileModel)).rejects.toThrow(FileServiceValidationError);
  });

  it('rejects a wrong-shaped model (Azure model handed to S3 adapter)', async () => {
    const azureModel = { provider: 'Azure', containerName: 'c', keyName: 'k' } as unknown as S3FileModel;
    await expect(service.uploadFile(azureModel)).rejects.toThrow(FileModelTypeMismatchError);
  });
});

describe('S3FileService.getKeys pagination and validation (spec §2.3, §2.4, §5)', () => {
  const service = new S3FileService(validOptions);

  beforeEach(() => {
    mockSend.mockReset();
  });

  it('rejects pageNumber <= 0 before any provider call', async () => {
    await expect(
      service.getKeys({ bucketOrContainer: 'b', pageNumber: 0, pageSize: 2 }),
    ).rejects.toThrow(FileServiceValidationError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects pageSize <= 0 before any provider call', async () => {
    await expect(
      service.getKeys({ bucketOrContainer: 'b', pageNumber: 1, pageSize: 0 }),
    ).rejects.toThrow(FileServiceValidationError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects a missing bucketOrContainer', async () => {
    await expect(
      service.getKeys({ bucketOrContainer: '', pageNumber: 1, pageSize: 2 }),
    ).rejects.toThrow(FileServiceValidationError);
  });

  it('walks and skips across multiple native pages to compute the requested page (spec §2.3)', async () => {
    // Native listing spans 2 provider pages of 2 items each: [a,b] then [c,d,e].
    // Request page 2 with pageSize 2 -> itemsToSkip = 2 -> expect [c, d].
    mockSend
      .mockImplementationOnce(async (command: unknown) => {
        expect(command).toBeInstanceOf(ListObjectsV2Command);
        return {
          Contents: [{ Key: 'a' }, { Key: 'b' }],
          IsTruncated: true,
          NextContinuationToken: 'token-1',
        };
      })
      .mockImplementationOnce(async () => ({
        Contents: [{ Key: 'c' }, { Key: 'd' }, { Key: 'e' }],
        IsTruncated: false,
      }));

    const keys = await service.getKeys({ bucketOrContainer: 'b', pageNumber: 2, pageSize: 2 });
    expect(keys).toEqual(['c', 'd']);
  });

  it('returns a shorter-than-pageSize list on the last page', async () => {
    mockSend.mockImplementationOnce(async () => ({
      Contents: [{ Key: 'a' }],
      IsTruncated: false,
    }));

    const keys = await service.getKeys({ bucketOrContainer: 'b', pageNumber: 1, pageSize: 5 });
    expect(keys).toEqual(['a']);
  });

  it('returns an empty list when pageNumber is beyond the end', async () => {
    mockSend.mockImplementationOnce(async () => ({
      Contents: [{ Key: 'a' }],
      IsTruncated: false,
    }));

    const keys = await service.getKeys({ bucketOrContainer: 'b', pageNumber: 10, pageSize: 5 });
    expect(keys).toEqual([]);
  });
});

describe('S3FileService.deleteFile / getSignedUrl existence precondition (spec §2.4, §5)', () => {
  const service = new S3FileService(validOptions);

  beforeEach(() => {
    mockSend.mockReset();
  });

  it('deleteFile rejects with a "does not exist" error and never calls DeleteObjectCommand when object is missing', async () => {
    mockSend.mockImplementationOnce(async () => {
      throw Object.assign(new Error('not found'), { name: 'NotFound' });
    });

    await expect(service.deleteFile(makeModel())).rejects.toThrow(FileNotFoundError);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('deleteFile calls DeleteObjectCommand when the object exists', async () => {
    mockSend.mockImplementationOnce(async () => ({})); // HeadObjectCommand success
    mockSend.mockImplementationOnce(async (command: unknown) => {
      expect(command).toBeInstanceOf(DeleteObjectCommand);
      return {};
    });

    await expect(service.deleteFile(makeModel())).resolves.toBeUndefined();
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('getSignedUrl rejects with a "does not exist" error and never generates a URL when object is missing', async () => {
    mockSend.mockImplementationOnce(async () => {
      throw Object.assign(new Error('not found'), { name: 'NotFound' });
    });

    await expect(service.getSignedUrl(makeModel(), 60)).rejects.toThrow(FileNotFoundError);
    expect(presignS3Url).not.toHaveBeenCalled();
  });

  it('getSignedUrl returns a URL when the object exists', async () => {
    mockSend.mockImplementationOnce(async () => ({})); // HeadObjectCommand success

    const url = await service.getSignedUrl(makeModel(), 60);
    expect(url).toBe('https://example-bucket.s3.amazonaws.com/signed');
    expect(presignS3Url).toHaveBeenCalledTimes(1);
  });
});

describe('S3FileService.uploadFile / getFileAsBytes do not pre-check existence (spec §2.4, §5)', () => {
  const service = new S3FileService(validOptions);

  beforeEach(() => {
    mockSend.mockReset();
  });

  it('uploadFile overwrites without checking existence first (single PutObjectCommand call)', async () => {
    mockSend.mockImplementationOnce(async (command: unknown) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      return {};
    });

    await service.uploadFile(makeModel({ filePath: '/tmp/whatever.txt' }));
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('getFileAsBytes propagates a raw "not found" error from the provider without an extra existence check', async () => {
    const notFound = Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    mockSend.mockImplementationOnce(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      throw notFound;
    });

    await expect(service.getFileAsBytes(makeModel())).rejects.toBe(notFound);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
