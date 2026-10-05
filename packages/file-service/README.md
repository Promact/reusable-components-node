# file-service

Provider-agnostic file storage for Node.js/TypeScript — AWS S3 and Azure Blob Storage behind one `IFileService<TFileModel>` interface. Behavioral port of the .NET `nuget-packages/file-service` library; see `docs/specs/nuget-packages-spec.md` §2 for the full functional spec.

## Installation

```bash
npm install @promact/file-service
```

## Usage

```ts
import { createS3FileService, S3FileModel } from '@promact/file-service';

const fileService = createS3FileService({
  accessKey: process.env.AWS_ACCESS_KEY_ID!,
  secretKey: process.env.AWS_SECRET_ACCESS_KEY!,
  region: 'us-east-1',
});

const file: S3FileModel = {
  provider: 'S3',
  bucketName: 'my-bucket',
  keyName: 'reports/2026-10.pdf',
  filePath: './reports/2026-10.pdf', // only needed for uploadFile
};

await fileService.uploadFile(file);
const url = await fileService.getSignedUrl(file, 3600);
const bytes = await fileService.getFileAsBytes(file);
const keys = await fileService.getKeys({ bucketOrContainer: 'my-bucket', pageNumber: 1, pageSize: 50 });
```

Azure Blob Storage works the same way with `createAzureBlobFileService({ connectionString })` and an `AzureFileModel` (`provider: 'Azure'`, `containerName`).

## API

| Method | Description |
|---|---|
| `uploadFile(model)` | Reads `model.filePath` from disk and uploads it, overwriting any existing object. |
| `getFileAsBytes(model)` | Downloads the object as a `Buffer`. |
| `deleteFile(model)` | Deletes the object; rejects with `FileNotFoundError` if it doesn't exist. |
| `getSignedUrl(model, expiresInSeconds)` | Returns a time-limited read URL (S3 presigned URL / Azure SAS URL); rejects with `FileNotFoundError` if it doesn't exist. |
| `checkFileExists(model)` | Resolves `true`/`false`. |
| `getKeys({ bucketOrContainer, pageNumber, pageSize })` | Lists object keys / blob names, 1-based paginated. |

## Provider notes

- Options are validated at construction time: S3 requires `accessKey`, `secretKey`, and a recognized AWS `region`; Azure requires `connectionString`. Invalid config throws `FileServiceConfigError`.
- Each adapter is typed to its own file model, and also checks it at runtime — passing an Azure model to the S3 service rejects with `FileModelTypeMismatchError`.
- `deleteFile` and `getSignedUrl` check existence first; `uploadFile` and `getFileAsBytes` don't, so a missing object in `getFileAsBytes` surfaces the provider's own "not found" error.
- `getKeys` pages by walking the provider's listing and skipping `(pageNumber - 1) * pageSize` items, so deep pages on large buckets make more provider calls.
- Exported error classes: `FileServiceConfigError`, `FileServiceValidationError`, `FileModelTypeMismatchError`, `FileNotFoundError`, `FileServiceOperationError` (wraps unexpected Azure failures, original error kept as `cause`).
