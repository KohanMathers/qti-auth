import { randomBytes } from 'node:crypto';

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
