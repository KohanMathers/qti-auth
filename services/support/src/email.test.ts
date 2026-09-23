import { describe, expect, it } from 'vitest';

import { emailNormalizer } from './email.ts';

describe('emailNormalizer', () => {
  const normalize = emailNormalizer({
    'gmail.com': { remove_dots: true, subaddress_separator: '+', domain: null },
    'googlemail.com': { remove_dots: true, subaddress_separator: '+', domain: 'gmail.com' },
  });

  it('folds gmail dots and tags onto one address', () => {
    expect(normalize('J.o.e+tag@gmail.com')).toBe('joe@gmail.com');
    expect(normalize('joe@googlemail.com')).toBe('joe@gmail.com');
    expect(normalize('Ada@Example.com')).toBe('ada@example.com');
  });
});
