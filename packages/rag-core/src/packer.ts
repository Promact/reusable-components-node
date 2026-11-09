import { Citation, ContextBudget, DocumentChunk, EmbeddingModel, KnowledgeRetriever, RetrievedContext, ScoredChunk, TokenCounter, VectorStore } from './models';
import { createRetriever } from './retriever';
import { exactTokenCounter, MarginTokenCounter } from './tokenizer';

/** Default context budget (spec §16). */
export const DEFAULT_CONTEXT_TOKENS = 4000;

export interface PackOptions {
  tokenCounter?: TokenCounter;
  /** Fetches parent chunks for small-to-big expansion; must apply the caller's security filter. */
  fetchParents?: (parentIds: string[]) => Promise<DocumentChunk[]>;
}

interface Item {
  /** The chunk whose text is shown: a leaf, or a parent replacing its leaves. */
  main: DocumentChunk;
  score: number;
  isParent: boolean;
}

/** Resolves the token limit (`maxTokens − margin`) and validates the budget. */
export function contextLimit(budget: Partial<ContextBudget> | undefined, counter: TokenCounter): number {
  const maxTokens = budget?.maxTokens ?? DEFAULT_CONTEXT_TOKENS;
  const margin = budget?.safetyMarginPercent ?? (counter as Partial<MarginTokenCounter>).safetyMarginPercent ?? 5;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('budget.maxTokens must be a positive integer');
  if (typeof margin !== 'number' || !(margin >= 0 && margin < 100)) throw new Error('budget.safetyMarginPercent must be in [0, 100)');
  if (budget?.format !== undefined && budget.format !== 'markdown') throw new Error('budget.format must be "markdown"');
  return Math.floor((maxTokens * (100 - margin)) / 100);
}

const prefixOf = (c: DocumentChunk): string => (c.headingPath.length ? `${c.headingPath.join(' > ')}\n\n` : '');
const samePath = (a: DocumentChunk, b: DocumentChunk) => a.headingPath.join('\u0000') === b.headingPath.join('\u0000');

/**
 * True when leaf `b` directly follows leaf `a` in the document. The chunker numbers parents and
 * leaves in one sequence and emits a parent right before its first leaf, so a gap of 2 is still
 * adjacent when the chunk in between is `b`'s parent (b starts a new parent group).
 */
function adjacent(a: DocumentChunk, b: DocumentChunk): boolean {
  if (a.documentId !== b.documentId || !samePath(a, b)) return false;
  const gap = b.ordinal - a.ordinal;
  return gap === 1 || (gap === 2 && b.parentChunkId !== undefined && b.parentChunkId !== a.parentChunkId);
}

/** Strongest first and last, weakest in the middle ("lost in the middle"). Input sorted by score desc. */
export function edgeOrder<T>(sorted: T[]): T[] {
  const front = sorted.filter((_, i) => i % 2 === 0);
  const back = sorted.filter((_, i) => i % 2 === 1).reverse();
  return [...front, ...back];
}

function render(items: Item[]): { text: string; citations: Citation[] } {
  // Merge adjacent leaves of one section into a single block.
  const byPosition = [...items].sort(
    (a, b) => a.main.documentId.localeCompare(b.main.documentId) || a.main.ordinal - b.main.ordinal,
  );
  const blocks: Item[][] = [];
  for (const it of byPosition) {
    const last = blocks[blocks.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && !prev.isParent && !it.isParent && adjacent(prev.main, it.main)) last.push(it);
    else blocks.push([it]);
  }
  const score = (b: Item[]) => Math.max(...b.map((i) => i.score));
  const ordered = edgeOrder(blocks.sort((a, b) => score(b) - score(a) || a[0].main.chunkId.localeCompare(b[0].main.chunkId)));

  const citations: Citation[] = [];
  const parts = ordered.map((block, n) => {
    const label = `[${n + 1}]`;
    const body = block
      .map((it, i) => {
        const p = prefixOf(it.main);
        return i > 0 && p && it.main.text.startsWith(p) ? it.main.text.slice(p.length) : it.main.text;
      })
      .join('\n\n');
    for (const it of block) {
      citations.push({
        label,
        documentId: it.main.documentId,
        chunkId: it.main.chunkId,
        ...(it.main.pageStart !== undefined ? { page: it.main.pageStart } : {}),
        headingPath: [...it.main.headingPath],
      });
    }
    return `${label} ${body}`;
  });
  return { text: parts.join('\n\n'), citations };
}

/**
 * Budgeted packing (spec §8.5): fills highest-scoring chunks first up to `maxTokens − margin`
 * (lowest-scoring are the ones dropped), expands a leaf to its parent only if the result still
 * fits, merges adjacent chunks, orders strongest at the edges and labels blocks `[n]`. Every
 * accepted state is measured on the final rendered text, so the output can never exceed the limit.
 */
export async function packContext(candidates: ScoredChunk[], budget: Partial<ContextBudget> | undefined, options: PackOptions = {}): Promise<RetrievedContext> {
  const counter = options.tokenCounter ?? exactTokenCounter();
  const limit = contextLimit(budget, counter);
  const fits = (items: Item[]) => counter.count(render(items).text) <= limit;

  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  let selected: Item[] = [];
  for (const c of sorted) {
    if (seen.has(c.chunk.chunkId)) continue;
    seen.add(c.chunk.chunkId);
    const trial = [...selected, { main: c.chunk, score: c.score, isParent: false }];
    if (fits(trial)) selected = trial;
  }

  // Small-to-big: replace a leaf (and its selected siblings) by the parent when there is room.
  const parentIds = [...new Set(selected.map((i) => i.main.parentChunkId).filter((id): id is string => !!id))];
  if (parentIds.length && options.fetchParents) {
    const parents = new Map((await options.fetchParents(parentIds)).map((p) => [p.chunkId, p]));
    for (const pid of parentIds) {
      const parent = parents.get(pid);
      const children = selected.filter((i) => i.main.parentChunkId === pid);
      if (!parent || parent.documentId !== children[0].main.documentId) continue;
      const trial = [
        ...selected.filter((i) => i.main.parentChunkId !== pid),
        { main: parent, score: Math.max(...children.map((i) => i.score)), isParent: true },
      ];
      if (fits(trial)) selected = trial;
    }
  }

  const { text, citations } = render(selected);
  const shownIds = new Set(selected.map((i) => i.main.chunkId));
  const included = [...seen].filter((id) => {
    if (shownIds.has(id)) return true;
    const parentId = sorted.find((c) => c.chunk.chunkId === id)?.chunk.parentChunkId;
    return parentId !== undefined && selected.some((i) => i.isParent && i.main.chunkId === parentId);
  }).length;
  return {
    text,
    citations,
    tokensUsed: text ? counter.count(text) : 0,
    candidatesConsidered: seen.size,
    chunksIncluded: included,
    chunksDropped: seen.size - included,
    graphFactsIncluded: 0,
  };
}

export interface KnowledgeRetrieverOptions {
  collection: string;
  embeddings: EmbeddingModel;
  vectorStore: VectorStore;
  tokenCounter?: TokenCounter;
  warn?: (message: string) => void;
}

/** Retrieve (mandatory tenant/ACL filter inside the store query) → MMR → budgeted packing. */
export function createKnowledgeRetriever(options: KnowledgeRetrieverOptions): KnowledgeRetriever {
  const counter = options.tokenCounter ?? exactTokenCounter();
  const retriever = createRetriever(options);
  return {
    async getContext(query, budget, signal) {
      contextLimit(budget, counter); // fail on a bad budget before spending an embedding call
      const { candidates, candidatesConsidered } = await retriever.retrieve(query, signal);
      const filter = { tenantId: query.filter.tenantId, aclGroups: [...query.filter.aclGroups] };
      const ctx = await packContext(candidates, budget, {
        tokenCounter: counter,
        fetchParents: (ids) => options.vectorStore.getByIds(options.collection, filter, ids, signal),
      });
      return { ...ctx, candidatesConsidered, chunksDropped: candidatesConsidered - ctx.chunksIncluded };
    },
  };
}
