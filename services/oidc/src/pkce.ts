import { createHash, randomBytes } from 'node:crypto';

export function pkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) return false;
  return pkceChallenge(verifier) === challenge;
}
