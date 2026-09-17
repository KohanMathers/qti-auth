import { describe, expect, it } from 'vitest';

import { isCanonicalLocale, preferredLocale } from './locale.ts';

describe('preferredLocale', () => {
  it('picks the highest-weighted valid language', () => {
    expect(preferredLocale('fr-CA;q=0.8, de;q=0.9, en-gb')).toBe('en-GB');
    expect(preferredLocale('fr-CA;q=0.8, de;q=0.9')).toBe('de');
    expect(preferredLocale('*, not a locale!, es')).toBe('es');
  });

  it('gives nothing without a usable language', () => {
    expect(preferredLocale(null)).toBeUndefined();
    expect(preferredLocale('*;q=1, fr;q=0')).toBeUndefined();
  });
});

describe('isCanonicalLocale', () => {
  it('accepts only canonical tags', () => {
    expect(isCanonicalLocale('en-GB')).toBe(true);
    expect(isCanonicalLocale('en_gb')).toBe(false);
    expect(isCanonicalLocale('en-gb')).toBe(false);
  });
});
