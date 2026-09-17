import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EncryptionKeyError, open, parseEncryptionKey, seal } from './envelope.ts';

const kek = randomBytes(32);

describe('parseEncryptionKey', () => {
  it('accepts a base64 32-byte key only', () => {
    expect(parseEncryptionKey(kek.toString('base64'), 'key')).toEqual(kek);
    for (const value of ['', 'short', randomBytes(16).toString('base64'), '!!!!']) {
      expect(() => parseEncryptionKey(value, 'gateway.identity_keys.encryption_key')).toThrow(
        EncryptionKeyError,
      );
    }
  });
});

describe('seal and open', () => {
  it('round-trips with the same key and associated data', () => {
    const secret = Buffer.from('private key material');
    const sealed = seal(secret, kek, 'kid-1');
    expect(sealed.ciphertext).not.toContain(secret.toString('base64url'));
    expect(open(sealed, kek, 'kid-1')).toEqual(secret);
  });

  it('refuses the wrong key, the wrong associated data or tampering', () => {
    const sealed = seal(Buffer.from('secret'), kek, 'kid-1');
    expect(() => open(sealed, randomBytes(32), 'kid-1')).toThrow();
    expect(() => open(sealed, kek, 'kid-2')).toThrow();
    const tampered = Buffer.from(sealed.ciphertext, 'base64url');
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() =>
      open({ ...sealed, ciphertext: tampered.toString('base64url') }, kek, 'kid-1'),
    ).toThrow();
  });
});
