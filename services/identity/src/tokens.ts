import { createHash, randomBytes } from 'node:crypto';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function isToken(value: string): boolean {
  return TOKEN.test(value);
}
