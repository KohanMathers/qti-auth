import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

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

export function encryptSecret(plaintext: Buffer, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(sealed: string, key: Buffer, aad: string): Buffer {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new EncryptionKeyError('Encrypted secret is not in the expected format');
  }
  const [, ivValue, tagValue, ciphertextValue] = parts;
  if (ivValue === undefined || tagValue === undefined || ciphertextValue === undefined) {
    throw new EncryptionKeyError('Encrypted secret is not in the expected format');
  }
  const iv = Buffer.from(ivValue, 'base64url');
  const tag = Buffer.from(tagValue, 'base64url');
  const ciphertext = Buffer.from(ciphertextValue, 'base64url');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new EncryptionKeyError('Encrypted secret is not in the expected format');
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
