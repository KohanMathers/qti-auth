import { blockSet, type WordLists } from './lists.ts';
import { normalize } from './normalize.ts';
import { collapseSingletons, tokenize } from './tokenize.ts';

export const FILTER_RULES = [
  'allowlist',
  'exact_block',
  'dictionary',
  'token_block',
  'token_padded_loose',
  'padded_loose',
  'unknown',
] as const;

export type FilterRule = (typeof FILTER_RULES)[number];
export type FilterDecision = 'allow' | 'block';

export interface FilterResult {
  decision: FilterDecision;
  rule: FilterRule;
  normalized: string;
  matched: string | null;
}

function allow(rule: FilterRule, normalized: string, matched: string | null = null): FilterResult {
  return { decision: 'allow', rule, normalized, matched };
}

function blocked(rule: FilterRule, normalized: string, matched: string): FilterResult {
  return { decision: 'block', rule, normalized, matched };
}

const PADDING = /[0-9_.\-x]+/g;

export function stripPadding(value: string): string {
  return value.replace(PADDING, '');
}

export function paddedWith(haystack: string, bucket: readonly string[]): string | null {
  for (const word of bucket) {
    const index = haystack.indexOf(word);
    if (index < 0) continue;
    const remainder = haystack.slice(0, index) + haystack.slice(index + word.length);
    if (stripPadding(remainder) === '') return word;
  }
  return null;
}

function looseWords(lists: WordLists): string[] {
  return [...lists.blockLoose].toSorted((a, b) => b.length - a.length || a.localeCompare(b));
}

export function filter(raw: string, lists: WordLists): FilterResult {
  const normalized = normalize(raw);
  const blockedWords = blockSet(lists);

  if (lists.allow.has(normalized)) return allow('allowlist', normalized, normalized);
  if (blockedWords.has(normalized)) return blocked('exact_block', normalized, normalized);
  if (lists.dictionary.has(normalized)) return allow('dictionary', normalized, normalized);

  const loose = looseWords(lists);
  for (const token of collapseSingletons(tokenize(raw))) {
    const value = normalize(token);
    if (value === '' || lists.allow.has(value)) continue;
    if (blockedWords.has(value)) return blocked('token_block', normalized, value);
    if (lists.dictionary.has(value)) continue;
    const padded = paddedWith(value, loose);
    if (padded !== null) return blocked('token_padded_loose', normalized, padded);
  }

  const padded = paddedWith(normalized, loose);
  if (padded !== null) return blocked('padded_loose', normalized, padded);
  return allow('unknown', normalized);
}
