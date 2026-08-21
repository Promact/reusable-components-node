import { Readable } from 'stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presignS3Url } from '@aws-sdk/s3-request-presigner';
import { readFile } from 'fs/promises';
import {
  IFileService,
  S3FileModel,
  S3FileServiceOptions,
  GetAllKeysRequest,
  VALID_AWS_REGIONS,
  FileServiceConfigError,
  FileNotFoundError,
  assertValidModel,
  assertValidGetAllKeysRequest,
} from '../types';

export class S3FileService implements IFileService<S3FileModel> {
  private readonly client: S3Client;

  constructor(options: S3FileServiceOptions) {
    if (!options.accessKey) {
      throw new FileServiceConfigError('S3FileService requires "accessKey".');
    }
    if (!options.secretKey) {
      throw new FileServiceConfigError('S3FileService requires "secretKey".');
    }
    if (!options.region || !VALID_AWS_REGIONS.has(options.region)) {
      throw new FileServiceConfigError(
        `S3FileService requires a valid "region"; received "${String(options.region)}".`,
      );
    }
    this.client = new S3Client({
      region: options.region,
      credentials: {
        accessKeyId: options.accessKey,
        secretAccessKey: options.secretKey,
      },
    });
  }

  async uploadFile(model: S3FileModel): Promise<void> {
    assertValidModel(model, 'S3');
    if (!model.filePath) {
      throw new FileServiceConfigError('uploadFile requires "filePath".');
    }
    const body = await readFile(model.filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: model.bucketName,
        Key: model.keyName,
        Body: body,
      }),
    );
  }

  async getFileAsBytes(model: S3FileModel): Promise<Buffer> {
    assertValidModel(model, 'S3');
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: model.bucketName, Key: model.keyName }),
    );
    return streamToBuffer(result.Body as Readable);
  }

  async deleteFile(model: S3FileModel): Promise<void> {
    assertValidModel(model, 'S3');
    const exists = await this.checkFileExists(model);
    if (!exists) {
      throw new FileNotFoundError(
        `Object "${model.keyName}" does not exist in bucket "${model.bucketName}".`,
      );
    }
    await this.client.send(
      new DeleteObjectCommand({ Bucket: model.bucketName, Key: model.keyName }),
    );
  }

  async getSignedUrl(model: S3FileModel, expiresInSeconds: number): Promise<string> {
    assertValidModel(model, 'S3');
    const exists = await this.checkFileExists(model);
    if (!exists) {
      throw new FileNotFoundError(
        `Object "${model.keyName}" does not exist in bucket "${model.bucketName}".`,
      );
    }
    return presignS3Url(
      this.client,
      new GetObjectCommand({ Bucket: model.bucketName, Key: model.keyName }),
      { expiresIn: expiresInSeconds },
    );
  }

  async checkFileExists(model: S3FileModel): Promise<boolean> {
    assertValidModel(model, 'S3');
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: model.bucketName, Key: model.keyName }),
      );
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async getKeys(request: GetAllKeysRequest): Promise<string[]> {
    assertValidGetAllKeysRequest(request);

    const itemsToSkip = (request.pageNumber - 1) * request.pageSize;
    const collected: string[] = [];
    let seenCount = 0;
    let continuationToken: string | undefined;

    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: request.bucketOrContainer,
          ContinuationToken: continuationToken,
        }),
      );
      const contents = page.Contents ?? [];
      for (const item of contents) {
        if (seenCount >= itemsToSkip && collected.length < request.pageSize) {
          if (item.Key != null) {
            collected.push(item.Key);
          }
        }
        seenCount += 1;
        if (collected.length >= request.pageSize) {
          return collected;
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    return collected;
  }
}

function isNotFoundError(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  const statusCode =
    (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || statusCode === 404;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
