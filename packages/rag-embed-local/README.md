# @promact/rag-embed-local

Offline `EmbeddingModel` for `@promact/rag-core` using transformers.js (ONNX). Private, not yet published.

```ts
import { createLocalEmbeddings } from '@promact/rag-embed-local';
const embeddings = createLocalEmbeddings(); // Xenova/all-MiniLM-L6-v2, 384 dims
```

- The model loads lazily on the first `embed` call and is cached on disk; weights are downloaded once from Hugging Face
  (set `cacheDir`, or pre-populate it, for air-gapped hosts). No egress afterwards.
- Vectors are L2-normalised. Changing `model` requires `dimensions`.
- Default model licence: Apache-2.0 per its model card (not re-verified in the sandbox, which blocks huggingface.co).
- Unit tests mock the pipeline: no download. A real-model test, if added, must skip unless `RAG_LOCAL_MODEL_TEST=1`.
