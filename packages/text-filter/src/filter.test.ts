import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { auditLists } from './audit.ts';
import { filter, type FilterResult } from './filter.ts';
import { deriveBlocklists, loadWordLists, type WordLists } from './lists.ts';
import { normalize } from './normalize.ts';
import { collapseSingletons, tokenize } from './tokenize.ts';
import { LEGACY_LDNOOBW_FILE, LIST_FILES } from './words.ts';

function lists(overrides: Partial<WordLists> = {}): WordLists {
  const dictionaryEnglish = new Set(
    overrides.dictionaryEnglish ?? ['classic', 'assassin', 'user', 'face', 'ask', 'pass'],
  );
  const dictionary = new Set([
    ...dictionaryEnglish,
    'scunthorpe',
    'john',
    'smith',
    ...(overrides.dictionary ?? []),
  ]);
  const ldnoobw =
    (overrides.blockExact ?? overrides.blockLoose)
      ? undefined
      : ['ass', 'cunt', 'fuck', 'slurword', 'xx', 'xxx'];
  const derived =
    overrides.blockExact !== undefined && overrides.blockLoose !== undefined
      ? { blockExact: overrides.blockExact, blockLoose: overrides.blockLoose }
      : deriveBlocklists(ldnoobw ?? [], dictionaryEnglish);
  return {
    allow: overrides.allow ?? new Set(),
    blockExact: overrides.blockExact ?? derived.blockExact,
    blockLoose: overrides.blockLoose ?? derived.blockLoose,
    blockExtra: overrides.blockExtra ?? new Set(['fuckface']),
    dictionary: overrides.dictionary ?? dictionary,
    dictionaryEnglish: overrides.dictionaryEnglish ?? dictionaryEnglish,
  };
}

function decision(raw: string, extra: Partial<WordLists> = {}): FilterResult {
  return filter(raw, lists(extra));
}

describe('normalize', () => {
  it('applies NFKC, strips bidi marks, maps confusables and leet, and lowercases', () => {
    expect(normalize('ＣＵＮＴ')).toBe('cunt');
    expect(normalize('c\u200Bunt')).toBe('cunt');
    expect(normalize('сunt')).toBe('cunt');
    expect(normalize('5hit')).toBe('shit');
    expect(normalize('USER1')).toBe('user1');
    expect(normalize('assassin')).toBe('assassin');
  });
});

describe('tokenize', () => {
  it('splits on underscores, digits and camelCase, and collapses single-character runs', () => {
    expect(tokenize('c_u_n_t')).toEqual(['c', 'u', 'n', 't']);
    expect(collapseSingletons(tokenize('c_u_n_t'))).toEqual(['cunt']);
    expect(tokenize('user1')).toEqual(['user', '1']);
    expect(tokenize('fuckFace')).toEqual(['fuck', 'Face']);
    expect(collapseSingletons(['c', 'u', 'n', 't', 'hello'])).toEqual(['cunt', 'hello']);
  });
});

describe('filter', () => {
  it('allows dictionary words before any substring search', () => {
    expect(decision('Scunthorpe')).toMatchObject({ decision: 'allow', rule: 'dictionary' });
    expect(decision('classic')).toMatchObject({ decision: 'allow', rule: 'dictionary' });
    expect(decision('assassin')).toMatchObject({ decision: 'allow', rule: 'dictionary' });
  });

  it('does not substring-match B_exact, so classic keeps ass', () => {
    expect(
      decision('classic', { dictionary: new Set(), dictionaryEnglish: new Set() }),
    ).toMatchObject({
      decision: 'allow',
      rule: 'unknown',
    });
  });

  it('allows user1 because 1 is never mapped to i', () => {
    expect(decision('user1')).toMatchObject({ decision: 'allow', rule: 'unknown' });
  });

  it('blocks whole-string and collapsed-token slurs', () => {
    expect(decision('cunt')).toMatchObject({
      decision: 'block',
      rule: 'exact_block',
      matched: 'cunt',
    });
    expect(decision('c_u_n_t')).toMatchObject({
      decision: 'block',
      rule: 'token_block',
      matched: 'cunt',
    });
  });

  it('blocks a B_loose word padded with x, digits or punctuation', () => {
    expect(decision('xxxslurwordxxx')).toMatchObject({
      decision: 'block',
      rule: 'token_padded_loose',
      matched: 'slurword',
    });
    expect(decision('slurword123')).toMatchObject({
      decision: 'block',
      rule: 'token_block',
      matched: 'slurword',
    });
  });

  it('blocks leet that the small map covers, without collapsing repeated letters', () => {
    expect(decision('5lurword')).toMatchObject({ decision: 'block', matched: 'slurword' });
    expect(decision('assassin')).toMatchObject({ decision: 'allow', rule: 'dictionary' });
  });

  it('honours the allowlist before the blocklists', () => {
    expect(decision('cunt', { allow: new Set(['cunt']) })).toMatchObject({
      decision: 'allow',
      rule: 'allowlist',
    });
  });

  it('extra-block wins over the dictionary', () => {
    expect(
      decision('cunts', {
        dictionary: new Set(['cunts']),
        blockExtra: new Set(['cunts']),
      }),
    ).toMatchObject({ decision: 'block', rule: 'exact_block', matched: 'cunts' });
  });

  it('fuckfaceIsNotAccepted', () => {
    expect(decision('fuckface')).toMatchObject({
      decision: 'block',
      rule: 'exact_block',
      matched: 'fuckface',
    });
    expect(decision('FuckFace')).toMatchObject({ decision: 'block', matched: 'fuckface' });
  });
});

describe('loadWordLists', () => {
  it('derives B_exact from short words and the English dictionary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qtiauth-lists-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, LIST_FILES.ldnoobw), 'ass\ncunt\nslurword\nxx\n');
    await writeFile(join(dir, LIST_FILES.dictionary), 'classic\nass\n');
    await writeFile(join(dir, LIST_FILES.names), 'John\n');
    await writeFile(join(dir, LIST_FILES.surnames), 'Smith\n');
    await writeFile(join(dir, LIST_FILES.places), 'Scunthorpe\n');
    await writeFile(join(dir, LIST_FILES.allow), '');
    await writeFile(join(dir, LIST_FILES.extraBlock), 'fuckface\n');
    const loaded = await loadWordLists(dir);
    expect(loaded.blockExact.has('ass')).toBe(true);
    expect(loaded.blockExact.has('xx')).toBe(true);
    expect(loaded.blockLoose.has('cunt')).toBe(true);
    expect(loaded.blockLoose.has('slurword')).toBe(true);
    expect(loaded.dictionary.has('scunthorpe')).toBe(true);
    expect(loaded.blockExtra.has('fuckface')).toBe(true);
  });

  it('still loads the English-only LDNOOBW filename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qtiauth-lists-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, LEGACY_LDNOOBW_FILE), 'putain\n');
    const loaded = await loadWordLists(dir);
    expect(loaded.blockLoose.has('putain')).toBe(true);
  });
});

describe('auditLists', () => {
  it('prints dictionary words that contain a blocked substring', () => {
    const hits = auditLists(
      lists({
        dictionary: new Set(['scunthorpe', 'hello']),
        dictionaryEnglish: new Set(['hello']),
        blockExact: new Set(['ass']),
        blockLoose: new Set(['cunt']),
        blockExtra: new Set(),
      }),
    );
    expect(hits).toEqual([{ word: 'scunthorpe', matched: 'cunt' }]);
  });
});
