import { countTokens as o200k } from 'gpt-tokenizer/cjs/encoding/o200k_base';
import { countTokens as cl100k } from 'gpt-tokenizer/cjs/encoding/cl100k_base';
import { TokenCounter } from './models';

export interface MarginTokenCounter extends TokenCounter {
  /** Default safety margin (%) a consumer should reserve when budgeting with this counter. */
  readonly safetyMarginPercent: number;
  readonly exact: boolean;
}

/** Exact BPE counts (gpt-tokenizer; o200k_base by default). Default margin 5%. */
export function exactTokenCounter(encoding: 'o200k_base' | 'cl100k_base' = 'o200k_base'): MarginTokenCounter {
  const fn = encoding === 'cl100k_base' ? cl100k : o200k;
  return { exact: true, safetyMarginPercent: 5, count: (text) => (text ? fn(text) : 0) };
}

export function tokenCounterFor(name: 'o200k_base' | 'cl100k_base' | 'approximate' | undefined): MarginTokenCounter {
  return name === 'approximate' ? approximateTokenCounter() : exactTokenCounter(name);
}

/** chars/4 estimate rounded up, for vendors without a local tokenizer. Default margin 15%. */
export function approximateTokenCounter(): MarginTokenCounter {
  return { exact: false, safetyMarginPercent: 15, count: (text) => Math.ceil(text.length / 4) };
}
