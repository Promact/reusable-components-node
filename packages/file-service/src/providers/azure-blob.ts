import { readFile } from 'fs/promises';
import { BlobServiceClient, BlobSASPermissions, RestError } from '@azure/storage-blob';
import {
  IFileService,
  AzureFileModel,
  AzureBlobFileServiceOptions,
  GetAllKeysRequest,
  FileServiceConfigError,
  FileNotFoundError,
  FileServiceOperationError,
  assertValidModel,
  assertValidGetAllKeysRequest,
} from '../types';

export class AzureBlobFileService implements IFileService<AzureFileModel> {
  private readonly client: BlobServiceClient;

  constructor(options: AzureBlobFileServiceOptions) {
    if (!options.connectionString) {
      throw new FileServiceConfigError('AzureBlobFileService requires "connectionString".');
    }
    this.client = BlobServiceClient.fromConnectionString(options.connectionString);
  }

  async uploadFile(model: AzureFileModel): Promise<void> {
    assertValidModel(model, 'Azure');
    if (!model.filePath) {
      throw new FileServiceConfigError('uploadFile requires "filePath".');
    }
    try {
      const body = await readFile(model.filePath);
      const container = this.client.getContainerClient(model.containerName);
      const blob = container.getBlockBlobClient(model.keyName);
      await blob.uploadData(body);
    } catch (error) {
      throw new FileServiceOperationError(
        `Error uploading file to Azure Blob Storage: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async getFileAsBytes(model: AzureFileModel): Promise<Buffer> {
    assertValidModel(model, 'Azure');
    const container = this.client.getContainerClient(model.containerName);
    const blob = container.getBlockBlobClient(model.keyName);
    return blob.downloadToBuffer();
  }

  async deleteFile(model: AzureFileModel): Promise<void> {
    assertValidModel(model, 'Azure');
    const exists = await this.checkFileExists(model);
    if (!exists) {
      throw new FileNotFoundError(
        `Blob "${model.keyName}" does not exist in container "${model.containerName}".`,
      );
    }
    try {
      const container = this.client.getContainerClient(model.containerName);
      const blob = container.getBlockBlobClient(model.keyName);
      await blob.delete();
    } catch (error) {
      throw new FileServiceOperationError(
        `Error deleting file from Azure Blob Storage: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async getSignedUrl(model: AzureFileModel, expiresInSeconds: number): Promise<string> {
    assertValidModel(model, 'Azure');
    const exists = await this.checkFileExists(model);
    if (!exists) {
      throw new FileNotFoundError(
        `Blob "${model.keyName}" does not exist in container "${model.containerName}".`,
      );
    }
    try {
      const container = this.client.getContainerClient(model.containerName);
      const blob = container.getBlockBlobClient(model.keyName);
      const expiresOn = new Date(Date.now() + expiresInSeconds * 1000);
      return await blob.generateSasUrl({ permissions: BlobSASPermissions.parse('r'), expiresOn });
    } catch (error) {
      throw new FileServiceOperationError(
        `Error getting signed URL for Azure Blob Storage: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async checkFileExists(model: AzureFileModel): Promise<boolean> {
    assertValidModel(model, 'Azure');
    const container = this.client.getContainerClient(model.containerName);
    const blob = container.getBlockBlobClient(model.keyName);
    return blob.exists();
  }

  async getKeys(request: GetAllKeysRequest): Promise<string[]> {
    assertValidGetAllKeysRequest(request);

    const itemsToSkip = (request.pageNumber - 1) * request.pageSize;
    const collected: string[] = [];
    let seenCount = 0;

    try {
      const container = this.client.getContainerClient(request.bucketOrContainer);
      for await (const blob of container.listBlobsFlat()) {
        if (seenCount >= itemsToSkip && collected.length < request.pageSize) {
          collected.push(blob.name);
        }
        seenCount += 1;
        if (collected.length >= request.pageSize) {
          break;
        }
      }
      return collected;
    } catch (error) {
      if (error instanceof RestError) {
        throw error;
      }
      throw new FileServiceOperationError(
        `An error occurred while retrieving keys: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
