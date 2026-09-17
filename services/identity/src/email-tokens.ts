import { randomUUIDv7 } from 'node:crypto';

import { deletedRows } from '@qtiauth/db';
import type { Kysely, Selectable } from 'kysely';

import type { Database, EmailTokenPurpose, EmailTokensTable } from './database.ts';
import { hashToken, isToken, newToken } from './tokens.ts';

export type TokenRow = Selectable<EmailTokensTable>;
export type TokenFailure = 'unknown' | 'used' | 'expired';

export async function insertEmailToken(
  db: Kysely<Database>,
  token: {
    purpose: EmailTokenPurpose;
    email: string;
    emailNormalized: string;
    locale: string | null;
    returnTo: string | null;
    userId: string | null;
    expiresAt: Date;
    now: Date;
  },
): Promise<string> {
  const value = newToken();
  await db
    .insertInto('email_tokens')
    .values({
      id: randomUUIDv7(),
      purpose: token.purpose,
      token_hash: hashToken(value),
      email: token.email,
      email_normalized: token.emailNormalized,
      locale: token.locale,
      return_to: token.returnTo,
      user_id: token.userId,
      created_at: token.now,
      expires_at: token.expiresAt,
    })
    .execute();
  return value;
}

export async function takeEmailToken(
  trx: Kysely<Database>,
  token: string,
  purpose: EmailTokenPurpose,
  now: Date,
): Promise<{ status: 'ok'; row: TokenRow } | { status: 'invalid'; reason: TokenFailure }> {
  if (!isToken(token)) return { status: 'invalid', reason: 'unknown' };
  const row = await trx
    .selectFrom('email_tokens')
    .selectAll()
    .where('token_hash', '=', hashToken(token))
    .where('purpose', '=', purpose)
    .forUpdate()
    .executeTakeFirst();
  if (!row) return { status: 'invalid', reason: 'unknown' };
  if (row.used_at !== null) return { status: 'invalid', reason: 'used' };
  if (row.expires_at <= now) return { status: 'invalid', reason: 'expired' };
  return { status: 'ok', row };
}

export async function useEmailToken(trx: Kysely<Database>, id: string, now: Date): Promise<void> {
  await trx.updateTable('email_tokens').set({ used_at: now }).where('id', '=', id).execute();
}

export async function sweepTokens(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<number> {
  const result = await db
    .deleteFrom('email_tokens')
    .where('expires_at', '<', new Date(options.now.getTime() - options.retention))
    .execute();
  return deletedRows(result);
}
