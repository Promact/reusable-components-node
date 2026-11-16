import { VectorStore } from './models';
import { Collection, storeOver } from './storeCore';

/** In-memory reference store for tests and small deployments. Applies tenant/ACL filters inside search. */
export function memoryVectorStore(): VectorStore {
  return storeOver(new Map<string, Collection>());
}
