import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret, EncryptionKeyError, parseEncryptionKey } from './encrypt.ts';

const KEY = Buffer.alloc(32, 9);

describe('parseEncryptionKey', () => {
  it('accepts a base64 32-byte key', () => {
    const value = KEY.toString('base64');
    expect(parseEncryptionKey(value, 'security.encryption_key')).toEqual(KEY);
  });

  it('rejects anything else', () => {
    expect(() => parseEncryptionKey('', 'security.encryption_key')).toThrow(EncryptionKeyError);
    expect(() => parseEncryptionKey('short', 'security.encryption_key')).toThrow(
      /security\.encryption_key must be a base64 32-byte key/,
    );
  });
});

describe('encryptSecret', () => {
  it('round-trips and binds the associated data', () => {
    const plaintext = randomBytes(20);
    const sealed = encryptSecret(plaintext, KEY, 'user-1');
    expect(decryptSecret(sealed, KEY, 'user-1')).toEqual(plaintext);
    expect(() => decryptSecret(sealed, KEY, 'user-2')).toThrow();
    expect(() => decryptSecret(sealed, Buffer.alloc(32, 1), 'user-1')).toThrow();
  });
});
