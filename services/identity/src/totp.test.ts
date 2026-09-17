import { describe, expect, it } from 'vitest';

import {
  decodeBase32,
  encodeBase32,
  otpauthUri,
  randomTotpSecret,
  totpAt,
  totpCode,
  verifyTotp,
} from './totp.ts';

describe('base32', () => {
  it('round-trips bytes', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(decodeBase32(encodeBase32(secret))).toEqual(secret);
  });
});

describe('totpCode', () => {
  it('matches RFC 6238 SHA-1 test vectors at the 6-digit modulus', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(totpCode(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(secret, Math.floor(1_111_111_109 / 30))).toBe('081804');
  });
});

describe('verifyTotp', () => {
  it('accepts the current window and one either side', () => {
    const secret = randomTotpSecret();
    const now = new Date('2026-09-17T12:00:00Z');
    expect(verifyTotp(secret, totpAt(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, new Date(now.getTime() - 30_000)), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, new Date(now.getTime() + 30_000)), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, new Date(now.getTime() - 90_000)), now)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
  });
});

describe('otpauthUri', () => {
  it('encodes the issuer and account', () => {
    const secret = Buffer.alloc(20, 1);
    expect(otpauthUri({ issuer: 'Example Account', account: 'sam@example.com', secret })).toBe(
      `otpauth://totp/Example%20Account:sam%40example.com?secret=${encodeBase32(secret)}&issuer=Example%20Account&algorithm=SHA1&digits=6&period=30`,
    );
  });
});
