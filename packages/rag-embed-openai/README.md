# @promact/rag-embed-openai

OpenAI and Azure OpenAI `EmbeddingModel` for `@promact/rag-core` (private, not yet published).

```ts
import { createOpenAiEmbeddings } from '@promact/rag-embed-openai';

const embeddings = createOpenAiEmbeddings({ model: 'text-embedding-3-small', apiKey: process.env.OPENAI_API_KEY!, dimensions: 512 });
const azure = createOpenAiEmbeddings({ model: 'text-embedding-3-small', apiKey, azure: { endpoint, apiVersion: '2024-10-21', deployment: 'emb' } });
```

- Batches (default 96 texts/request), keeps input order, validates vector sizes.
- Retries 408/409/429/5xx and connection errors (`maxRetries`, default 4) via the OpenAI SDK, which waits for `Retry-After` / `retry-after-ms`.
- `dimensions` shortens vectors for `text-embedding-3-*`; unknown models need `dimensions` or `nativeDimensions`.
- Tests are fully mocked (including a retry test against a fake `fetch`). Real-service tests, if added, must skip unless `OPENAI_API_KEY` is set.
