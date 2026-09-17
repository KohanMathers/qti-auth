import type { Kysely } from 'kysely';

import { BIND_CODE_TTL, type BindStore } from './bind-state.ts';
import type { Database } from './database.ts';
import { bindCookieScope } from './sessions.ts';
import { newToken } from './tokens.ts';

export { BIND_CODE_TTL };

export async function issueBindCode(
  store: BindStore,
  binding: { sessionId: string; target: string; origin: string; returnPath: string },
): Promise<{ code: string; expiresAt: Date }> {
  const code = newToken();
  const createdAt = Date.now();
  await store.put(code, {
    sessionId: binding.sessionId,
    target: binding.target,
    origin: binding.origin,
    returnPath: binding.returnPath,
    createdAt,
  });
  return { code, expiresAt: new Date(createdAt + BIND_CODE_TTL) };
}

export type CompleteBindResult =
  { status: 'ok'; token: string; expiresAt: Date; returnPath: string } | { status: 'invalid' };

export async function completeBind(
  db: Kysely<Database>,
  store: BindStore,
  options: {
    code: string;
    target: string;
    origin: string;
    cookieScope: string;
    idleTimeout: number;
    now: Date;
  },
): Promise<CompleteBindResult> {
  const stored = await store.take(options.code);
  if (stored?.target !== options.target || stored.origin !== options.origin) {
    return { status: 'invalid' };
  }
  const bound = await bindCookieScope(db, {
    sessionId: stored.sessionId,
    cookieScope: options.cookieScope,
    idleTimeout: options.idleTimeout,
    now: options.now,
  });
  if (bound === null) return { status: 'invalid' };
  return {
    status: 'ok',
    token: bound.token,
    expiresAt: bound.expiresAt,
    returnPath: stored.returnPath,
  };
}
