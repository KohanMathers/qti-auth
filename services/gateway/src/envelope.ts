import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import * as z from 'zod';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

export const sealedSecretSchema = z.strictObject({
  alg: z.literal('A256GCM'),
  wrapped_key: z.base64url(),
  iv: z.base64url(),
  tag: z.base64url(),
  ciphertext: z.base64url(),
});

export type SealedSecret = z.output<typeof sealedSecretSchema>;

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

export function parseEncryptionKey(value: string, setting: string): Buffer {
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(value)
    ? Buffer.from(value, 'base64')
    : Buffer.alloc(0);
  if (key.length !== KEY_LENGTH) {
    throw new EncryptionKeyError(
      `${setting} must be a base64 32-byte key. Generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

function encrypt(key: Buffer, plaintext: Buffer, aad: string) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function decrypt(key: Buffer, iv: Buffer, tag: Buffer, ciphertext: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function seal(plaintext: Buffer, kek: Buffer, aad: string): SealedSecret {
  const dek = randomBytes(KEY_LENGTH);
  const wrapped = encrypt(kek, dek, aad);
  const sealed = encrypt(dek, plaintext, aad);
  return {
    alg: 'A256GCM',
    wrapped_key: Buffer.concat([wrapped.iv, wrapped.tag, wrapped.ciphertext]).toString('base64url'),
    iv: sealed.iv.toString('base64url'),
    tag: sealed.tag.toString('base64url'),
    ciphertext: sealed.ciphertext.toString('base64url'),
  };
}

export function open(sealed: SealedSecret, kek: Buffer, aad: string): Buffer {
  const wrapped = Buffer.from(sealed.wrapped_key, 'base64url');
  const dek = decrypt(
    kek,
    wrapped.subarray(0, IV_LENGTH),
    wrapped.subarray(IV_LENGTH, IV_LENGTH + 16),
    wrapped.subarray(IV_LENGTH + 16),
    aad,
  );
  return decrypt(
    dek,
    Buffer.from(sealed.iv, 'base64url'),
    Buffer.from(sealed.tag, 'base64url'),
    Buffer.from(sealed.ciphertext, 'base64url'),
    aad,
  );
}
