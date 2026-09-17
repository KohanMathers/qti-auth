import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { emailNormalizer } from './email.ts';

const normalize = emailNormalizer(sections.accounts.parse({}).email_normalization);

describe('emailNormalizer', () => {
  it('ignores case and surrounding space everywhere', () => {
    expect(normalize('  Sam.Smith+News@Example.COM ')).toBe('sam.smith+news@example.com');
  });

  it('applies the built-in Gmail rules', () => {
    expect(normalize('Sam.Smith+news@gmail.com')).toBe('samsmith@gmail.com');
    expect(normalize('s.a.m.smith@GoogleMail.com')).toBe('samsmith@gmail.com');
  });

  it('keeps a local part that starts with the separator', () => {
    expect(normalize('+sam@gmail.com')).toBe('+sam@gmail.com');
  });

  it('uses rules from config instead of the built-in ones', () => {
    const custom = emailNormalizer({
      'Example.com': { remove_dots: false, subaddress_separator: '-', domain: null },
      'mail.example.net': { remove_dots: false, subaddress_separator: null, domain: 'example.com' },
    });
    expect(custom('sam-shop@example.com')).toBe('sam@example.com');
    expect(custom('sam.smith@mail.example.net')).toBe('sam.smith@example.com');
    expect(custom('Sam.Smith+x@gmail.com')).toBe('sam.smith+x@gmail.com');
  });

  it('compares internationalized domains in their ASCII form', () => {
    expect(normalize('sam@bücher.example')).toBe(normalize('sam@xn--bcher-kva.example'));
  });
});
