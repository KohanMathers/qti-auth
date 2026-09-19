import { describe, expect, it } from 'vitest';

import { displayUserCode, normalizeUserCode, newUserCode } from './device.ts';

describe('user codes', () => {
  it('issues hyphenated codes from the RFC 8628 alphabet', () => {
    const code = newUserCode();
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    const normalized = normalizeUserCode(code);
    expect(normalized).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
    expect(displayUserCode(normalized ?? '')).toBe(code);
  });

  it('accepts spaces and mixed case, and rejects vowels and the wrong length', () => {
    expect(normalizeUserCode('wdjb mjht')).toBe('WDJBMJHT');
    expect(normalizeUserCode('WDJB-MJHT')).toBe('WDJBMJHT');
    expect(normalizeUserCode('AEIO-UXYZ')).toBeUndefined();
    expect(normalizeUserCode('WDJB')).toBeUndefined();
  });
});
