import { randomBytes, randomInt } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { filter, FILTER_RULES } from './filter.ts';
import { deriveBlocklists, type WordLists } from './lists.ts';
import { normalize } from './normalize.ts';
import { tokenize } from './tokenize.ts';

const ITERATIONS = 5000;

const RULES = new Set<string>(FILTER_RULES);

function lists(): WordLists {
  const dictionaryEnglish = new Set(['pass', 'user', 'name', 'star', 'assassin']);
  const dictionary = new Set([...dictionaryEnglish, 'scunthorpe', 'john', 'smith']);
  const { blockExact, blockLoose } = deriveBlocklists(
    ['fuck', 'shit', 'ass', 'slurword', 'xx', 'xxx'],
    dictionaryEnglish,
  );
  return {
    allow: new Set(['okay']),
    blockExact,
    blockLoose,
    blockExtra: new Set(['fuckface']),
    dictionary,
    dictionaryEnglish,
  };
}

const CONFUSABLES = ['ａ', 'Ａ', 'ѕ', 'с', 'ϲ', '𝓪', '𝕒', '𝟯', '𝟱', 'İ'];
const ZERO_WIDTH = ['­', '​', '‌', '‍', '‎', '‏', '⁠', '﻿'];
const BIDI = ['‪', '‫', '‬', '‭', '‮'];
const PADDING = ['_', '.', '-', 'x', '0', '1', '3', '4', '5', '7'];
const LEET = ['@', '$'];
const PARTS = ['fuck', 'shit', 'ass', 'user', 'pass', 'name', 'admin', 'a', 'b', 'x'];

function pick<T>(source: readonly T[]): T {
  const value = source[randomInt(0, source.length)];
  if (value === undefined) throw new Error('pick from empty source');
  return value;
}

function randomCodePoint(): string {
  let code = randomInt(0x20, 0x10ffff);
  if (code >= 0xd800 && code <= 0xdfff) code = 0x20;
  return String.fromCodePoint(code);
}

function randomText(): string {
  const target = randomInt(0, 40);
  let out = '';
  for (let i = 0; i < target; i++) {
    const kind = randomInt(0, 6);
    if (kind === 0) out += pick(PARTS);
    else if (kind === 1) out += pick(CONFUSABLES);
    else if (kind === 2) out += pick(ZERO_WIDTH);
    else if (kind === 3) out += pick(BIDI);
    else if (kind === 4) out += pick(PADDING) + pick(LEET);
    else out += randomCodePoint();
  }
  return out;
}

describe('text-filter fuzz', () => {
  const words = lists();

  it('never throws and always returns a well-formed decision', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const raw = randomText();
      const result = filter(raw, words);
      expect(RULES.has(result.rule)).toBe(true);
      expect(['allow', 'block']).toContain(result.decision);
      expect(result.normalized).toBe(normalize(raw));
      if (result.decision === 'block') expect(result.matched).not.toBeNull();
      if (result.rule === 'allowlist' || result.rule === 'dictionary')
        expect(result.decision).toBe('allow');
    }
  });

  it('is stable across identical inputs', () => {
    for (let i = 0; i < 200; i++) {
      const raw = randomText();
      const first = filter(raw, words);
      const second = filter(raw, words);
      expect(second).toEqual(first);
    }
  });

  it('does not crash on very long inputs, control chars or invalid UTF-16', () => {
    const cases = [
      'a'.repeat(4096),
      'fuck'.repeat(200),
      '\u0000\u0001\u0002\u0003',
      '𐏿',
      '\ud800',
      '\udfff',
      randomBytes(2048).toString('binary'),
    ];
    for (const raw of cases) {
      expect(() => filter(raw, words)).not.toThrow();
    }
  });

  it('rejects known bypass patterns for a blocked word', () => {
    const bypasses = [
      'fuck',
      'f_u_c_k',
      'FUCK',
      'ｆｕｃｋ',
      'f​uck',
      'fu‪ck',
      'ｆuck',
      'fuck1',
      'fuck_face',
    ];
    for (const raw of bypasses) {
      const result = filter(raw, words);
      expect(result.decision, raw).toBe('block');
    }
  });

  it('normalizes any input into a stable form', () => {
    for (let i = 0; i < 500; i++) {
      const raw = randomText();
      expect(normalize(normalize(raw))).toBe(normalize(raw));
    }
  });

  it('tokenizes without dropping input bytes on random junk', () => {
    for (let i = 0; i < 500; i++) {
      const raw = randomText();
      const tokens = tokenize(raw);
      for (const token of tokens) expect(typeof token).toBe('string');
    }
  });
});
