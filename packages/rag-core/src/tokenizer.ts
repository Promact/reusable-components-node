import { countTokens } from 'gpt-tokenizer';
import { TokenCounter } from './models';

export interface MarginTokenCounter extends TokenCounter {
  /** Default safety margin (%) a consumer should reserve when budgeting with this counter. */
  readonly safetyMarginPercent: number;
  readonly exact: boolean;
}

/** Exact BPE counts (gpt-tokenizer, o200k_base). Default margin 5%. */
export function exactTokenCounter(): MarginTokenCounter {
  return { exact: true, safetyMarginPercent: 5, count: (text) => (text ? countTokens(text) : 0) };
}

/** chars/4 estimate rounded up, for vendors without a local tokenizer. Default margin 15%. */
export function approximateTokenCounter(): MarginTokenCounter {
  return { exact: false, safetyMarginPercent: 15, count: (text) => Math.ceil(text.length / 4) };
}
