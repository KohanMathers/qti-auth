import {
  REVOKED_SESSIONS_HEADER,
  SESSION_CLEAR_HEADER,
  SESSION_EXPIRES_HEADER,
  SESSION_TOKEN_HEADER,
} from '@qtiauth/service-kit';

import type { CreatedSession } from './sessions.ts';

export const NO_STORE = { 'cache-control': 'no-store' };

export function sessionHeaders(
  session: Pick<CreatedSession, 'id' | 'token' | 'expiresAt' | 'evicted' | 'restored'>,
): Record<string, string> {
  if (session.restored) return revokedHeaders([...session.evicted, session.id]);
  return {
    ...revokedHeaders(session.evicted),
    [SESSION_TOKEN_HEADER]: session.token,
    [SESSION_EXPIRES_HEADER]: session.expiresAt.toISOString(),
  };
}

export function revokedHeaders(revoked: readonly string[]): Record<string, string> {
  return {
    ...NO_STORE,
    ...(revoked.length > 0 ? { [REVOKED_SESSIONS_HEADER]: revoked.join(', ') } : {}),
  };
}

export function signedOutHeaders(revoked: readonly string[]): Record<string, string> {
  return { ...revokedHeaders(revoked), [SESSION_CLEAR_HEADER]: '1' };
}
