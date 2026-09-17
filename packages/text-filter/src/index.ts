import { createHash } from 'node:crypto';

import { type AuditHit, auditLists } from './audit.ts';
import {
  filter,
  FILTER_RULES,
  type FilterDecision,
  type FilterResult,
  type FilterRule,
  paddedWith,
  stripPadding,
} from './filter.ts';
import {
  blockSet,
  DEFAULT_LISTS_DIR,
  emptyWordLists,
  LIST_FILES,
  type LoadedLists,
  loadWordLists,
  resolveListsDir,
  type WordLists,
} from './lists.ts';
import { normalize } from './normalize.ts';
import { collapseSingletons, tokenize } from './tokenize.ts';
import { DEFAULT_LDNOOBW_COMMIT, LDNOOBW_LANGS, ListUpdateError, updateLists } from './update.ts';
import {
  foldListWord,
  formatWordList,
  LEGACY_LDNOOBW_FILE,
  parseWordList,
  stripLdnoobwSpaces,
} from './words.ts';

export {
  auditLists,
  blockSet,
  collapseSingletons,
  DEFAULT_LDNOOBW_COMMIT,
  DEFAULT_LISTS_DIR,
  emptyWordLists,
  filter,
  FILTER_RULES,
  foldListWord,
  formatWordList,
  LDNOOBW_LANGS,
  LEGACY_LDNOOBW_FILE,
  LIST_FILES,
  ListUpdateError,
  loadWordLists,
  normalize,
  resolveListsDir,
  paddedWith,
  parseWordList,
  stripLdnoobwSpaces,
  stripPadding,
  tokenize,
  updateLists,
};

export type { AuditHit, FilterDecision, FilterResult, FilterRule, LoadedLists, WordLists };

export function inputHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class TextFilter {
  readonly lists: LoadedLists;
  readonly fileAllow: ReadonlySet<string>;
  readonly fileExtra: ReadonlySet<string>;

  constructor(lists: LoadedLists) {
    this.lists = lists;
    this.fileAllow = new Set(lists.allow);
    this.fileExtra = new Set(lists.blockExtra);
  }

  check(raw: string): FilterResult {
    return filter(raw, this.lists);
  }

  addAllow(word: string): string {
    const normalized = normalize(word);
    this.lists.allow.add(normalized);
    return normalized;
  }

  removeAllow(word: string): boolean {
    return this.lists.allow.delete(normalize(word));
  }

  addExtraBlock(word: string): string {
    const normalized = normalize(word);
    this.lists.blockExtra.add(normalized);
    return normalized;
  }

  removeExtraBlock(word: string): boolean {
    return this.lists.blockExtra.delete(normalize(word));
  }
}

export async function openTextFilter(dir: string): Promise<TextFilter> {
  return new TextFilter(await loadWordLists(dir));
}
