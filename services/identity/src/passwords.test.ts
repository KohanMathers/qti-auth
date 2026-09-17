import { describe, expect, it, vi } from 'vitest';

import {
  checkBreachedPassword,
  dummyPasswordHash,
  emailLocalPart,
  hashPassword,
  HIBP_RANGE_URL,
  needsRehash,
  parsePasswordHash,
  passwordContainsIdentifier,
  passwordPolicyReason,
  verifyPassword,
} from './passwords.ts';

const params = { memoryKib: 8, iterations: 1, parallelism: 1 };
const owasp = { memoryKib: 19_456, iterations: 2, parallelism: 1 };
const policy = {
  minLength: 10,
  maxLength: 256,
  requireLower: false,
  requireUpper: false,
  requireDigit: false,
  requireSymbol: false,
};

describe('password hashing', () => {
  it('verifies Argon2id hashes and rehashes when parameters change', async () => {
    const encoded = await hashPassword('correct horse', params);
    expect(encoded.startsWith('$argon2id$v=19$m=8,t=1,p=1$')).toBe(true);
    expect(await verifyPassword('correct horse', encoded)).toBe(true);
    expect(await verifyPassword('wrong horse', encoded)).toBe(false);
    expect(needsRehash(encoded, params)).toBe(false);
    expect(needsRehash(encoded, owasp)).toBe(true);
    expect(parsePasswordHash('not-a-hash')).toBeUndefined();
    expect(await verifyPassword('correct horse', 'not-a-hash')).toBe(false);
  });

  it('hashes with the OWASP defaults', async () => {
    const encoded = await hashPassword('correct horse battery', owasp);
    expect(encoded).toContain('m=19456,t=2,p=1');
    expect(await verifyPassword('correct horse battery', encoded)).toBe(true);
  });

  it('uses a dummy hash that verifies like a real one', async () => {
    const dummy = await dummyPasswordHash(params);
    const real = await hashPassword('correct horse', params);
    expect(await verifyPassword('nope', dummy)).toBe(false);
    expect(await verifyPassword('nope', real)).toBe(false);
    expect(await dummyPasswordHash(params)).toBe(dummy);
  });
});

describe('password policy', () => {
  it('enforces length, composition, and email local-part containment', () => {
    expect(passwordPolicyReason('short', policy, [])).toBe('too_short');
    expect(passwordPolicyReason('x'.repeat(257), { ...policy, maxLength: 256 }, [])).toBe(
      'too_long',
    );
    expect(passwordPolicyReason('alllowercase1!', { ...policy, requireUpper: true }, [])).toBe(
      'need_upper',
    );
    expect(passwordPolicyReason('ALLUPPERCASE1!', { ...policy, requireLower: true }, [])).toBe(
      'need_lower',
    );
    expect(passwordPolicyReason('NoDigitsHere!', { ...policy, requireDigit: true }, [])).toBe(
      'need_digit',
    );
    expect(passwordPolicyReason('NoSymbols123', { ...policy, requireSymbol: true }, [])).toBe(
      'need_symbol',
    );
    expect(passwordPolicyReason('long-enough-secret', policy, [])).toBeUndefined();
    expect(emailLocalPart('Sam.Smith+news@example.com')).toBe('Sam.Smith+news');
    expect(passwordContainsIdentifier('my-sam.smith-pass', ['Sam.Smith'])).toBe(true);
    expect(passwordContainsIdentifier('unrelated-password', ['ab'])).toBe(false);
    expect(passwordPolicyReason('samsmith-is-here', policy, ['samsmith'])).toBe(
      'contains_identifier',
    );
  });
});

describe('HIBP k-anonymity', () => {
  it('rejects a suffix match and fails open when the range API is down', async () => {
    const fetchImpl = vi.fn((input: string | URL) => {
      expect(String(input)).toBe(`${HIBP_RANGE_URL}5BAA6`);
      return Promise.resolve(
        new Response(
          '1E4C9B93F3F0682250B6CF8331B7EE68FD8:2\n00D4F6E8DAE5B9A7F3B43841ECB6A3DC4C9:1\n',
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    expect(await checkBreachedPassword('password', { fetch: fetchImpl })).toBe('rejected');

    const missing = vi.fn(() =>
      Promise.resolve(new Response('00D4F6E8DAE5B9A7F3B43841ECB6A3DC4C9:1\n')),
    ) as typeof fetch;
    expect(await checkBreachedPassword('password', { fetch: missing })).toBe('passed');

    const down = vi.fn(() => Promise.reject(new Error('offline'))) as typeof fetch;
    expect(await checkBreachedPassword('password', { fetch: down })).toBe('unavailable');
  });
});

describe('equal-time hashing', () => {
  it('takes indistinguishably long for a stored hash and the dummy hash', async () => {
    const password = 'correct horse battery';
    const stored = await hashPassword(password, params);
    const dummy = await dummyPasswordHash(params);
    const samples = 24;
    const storedTimes: number[] = [];
    const dummyTimes: number[] = [];
    for (let i = 0; i < samples; i++) {
      let start = performance.now();
      expect(await verifyPassword('wrong password value', stored)).toBe(false);
      storedTimes.push(performance.now() - start);
      start = performance.now();
      expect(await verifyPassword('wrong password value', dummy)).toBe(false);
      dummyTimes.push(performance.now() - start);
    }
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = (values: number[]) => {
      const avg = mean(values);
      return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
    };
    const diff = Math.abs(mean(storedTimes) - mean(dummyTimes));
    const se = Math.sqrt(variance(storedTimes) / samples + variance(dummyTimes) / samples);
    expect(diff).toBeLessThan(3 * se + 5);
  });
});
