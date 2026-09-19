import { randomBytes, timingSafeEqual } from 'node:crypto';

import { hashSessionToken, SESSION_TOKEN_HASH } from '@qtiauth/service-kit';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return hashSessionToken(token);
}

export function isToken(value: string): boolean {
  return SESSION_TOKEN_HASH.test(value);
}

export function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
