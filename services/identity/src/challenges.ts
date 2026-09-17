import { randomUUIDv7 } from 'node:crypto';

import { deletedRows } from '@qtiauth/db';
import type { Kysely, Selectable } from 'kysely';

import type { AuthChallengeKind, AuthChallengesTable, Database } from './database.ts';
import { hashToken, isToken, newToken } from './tokens.ts';

export const CHALLENGE_TTL = 5 * 60_000;

export type ChallengeRow = Selectable<AuthChallengesTable>;
export type ChallengeFailure = 'unknown' | 'used' | 'expired';

export async function insertChallenge(
  db: Kysely<Database>,
  challenge: {
    kind: AuthChallengeKind;
    userId: string | null;
    sessionId?: string | null;
    payload: unknown;
    now: Date;
    ttl?: number;
  },
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(challenge.now.getTime() + (challenge.ttl ?? CHALLENGE_TTL));
  await db
    .insertInto('auth_challenges')
    .values({
      id: randomUUIDv7(),
      token_hash: hashToken(token),
      user_id: challenge.userId,
      session_id: challenge.sessionId ?? null,
      kind: challenge.kind,
      payload: JSON.stringify(challenge.payload),
      created_at: challenge.now,
      expires_at: expiresAt,
    })
    .execute();
  return { token, expiresAt };
}

export async function takeChallenge(
  trx: Kysely<Database>,
  token: string,
  kind: AuthChallengeKind | readonly AuthChallengeKind[],
  now: Date,
): Promise<{ status: 'ok'; row: ChallengeRow } | { status: 'invalid'; reason: ChallengeFailure }> {
  if (!isToken(token)) return { status: 'invalid', reason: 'unknown' };
  const kinds = typeof kind === 'string' ? [kind] : kind;
  const row = await trx
    .selectFrom('auth_challenges')
    .selectAll()
    .where('token_hash', '=', hashToken(token))
    .where('kind', 'in', [...kinds])
    .forUpdate()
    .executeTakeFirst();
  if (!row) return { status: 'invalid', reason: 'unknown' };
  if (row.used_at !== null) return { status: 'invalid', reason: 'used' };
  if (row.expires_at <= now) return { status: 'invalid', reason: 'expired' };
  return { status: 'ok', row };
}

export async function useChallenge(trx: Kysely<Database>, id: string, now: Date): Promise<void> {
  await trx.updateTable('auth_challenges').set({ used_at: now }).where('id', '=', id).execute();
}

export function challengePayload(row: ChallengeRow): unknown {
  return JSON.parse(row.payload) as unknown;
}

export async function sweepChallenges(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<number> {
  const result = await db
    .deleteFrom('auth_challenges')
    .where('expires_at', '<', new Date(options.now.getTime() - options.retention))
    .execute();
  return deletedRows(result);
}
