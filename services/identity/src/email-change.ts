import { accountsWithEmail, activateVerifiedEmail, findAccount, lockEmail } from './accounts.ts';
import type { Database } from './database.ts';
import {
  insertEmailToken,
  takeEmailToken,
  type TokenFailure,
  useEmailToken,
} from './email-tokens.ts';
import type { Kysely } from 'kysely';

export interface EmailChangeSettings {
  changeTtl: number;
  revertTtl: number;
  maxPerEmail: number;
  normalizeEmail: (address: string) => string;
}

export type StartEmailChangeResult =
  | { status: 'not_found' }
  | { status: 'unchanged' }
  | { status: 'account_limit' }
  | {
      status: 'started';
      confirmToken: string;
      confirmExpiresAt: Date;
      revertToken: string;
      revertExpiresAt: Date;
      previousEmail: string;
      locale: string | null;
    };

export type ConfirmEmailChangeResult =
  | { status: 'invalid'; reason: TokenFailure }
  | { status: 'account_limit' }
  | { status: 'confirmed'; userId: string; email: string };

export type RevertEmailChangeResult =
  | { status: 'invalid'; reason: TokenFailure }
  | { status: 'account_limit' }
  | { status: 'reverted'; userId: string; email: string };

export async function startEmailChange(
  db: Kysely<Database>,
  options: {
    userId: string;
    email: string;
    settings: EmailChangeSettings;
    now: Date;
  },
): Promise<StartEmailChangeResult> {
  const account = await findAccount(db, options.userId);
  if (!account || account.state === 'deleted') return { status: 'not_found' };
  const next = options.email.trim();
  const nextNormalized = options.settings.normalizeEmail(next);
  const previousNormalized = options.settings.normalizeEmail(account.email);
  if (nextNormalized === previousNormalized) return { status: 'unchanged' };

  return db.transaction().execute(async (trx) => {
    await lockEmail(trx, nextNormalized);
    const existing = await accountsWithEmail(trx, nextNormalized);
    const others = existing.filter((row) => row.id !== options.userId);
    if (others.length >= options.settings.maxPerEmail) return { status: 'account_limit' as const };

    await trx
      .updateTable('email_tokens')
      .set({ used_at: options.now })
      .where('user_id', '=', options.userId)
      .where('purpose', '=', 'email_change')
      .where('used_at', 'is', null)
      .execute();

    const confirmExpiresAt = new Date(options.now.getTime() + options.settings.changeTtl);
    const revertExpiresAt = new Date(options.now.getTime() + options.settings.revertTtl);
    const confirmToken = await insertEmailToken(trx, {
      purpose: 'email_change',
      email: next,
      emailNormalized: nextNormalized,
      locale: account.locale,
      returnTo: account.email,
      userId: options.userId,
      expiresAt: confirmExpiresAt,
      now: options.now,
    });
    const revertToken = await insertEmailToken(trx, {
      purpose: 'email_revert',
      email: account.email,
      emailNormalized: previousNormalized,
      locale: account.locale,
      returnTo: next,
      userId: options.userId,
      expiresAt: revertExpiresAt,
      now: options.now,
    });
    return {
      status: 'started' as const,
      confirmToken,
      confirmExpiresAt,
      revertToken,
      revertExpiresAt,
      previousEmail: account.email,
      locale: account.locale,
    };
  });
}

export function confirmEmailChange(
  db: Kysely<Database>,
  options: { token: string; settings: EmailChangeSettings; now: Date },
): Promise<ConfirmEmailChangeResult> {
  return db.transaction().execute(async (trx) => {
    const taken = await takeEmailToken(trx, options.token, 'email_change', options.now);
    if (taken.status === 'invalid') return taken;
    const { row } = taken;
    if (row.user_id === null) return { status: 'invalid' as const, reason: 'unknown' as const };
    await lockEmail(trx, row.email_normalized);
    const existing = await accountsWithEmail(trx, row.email_normalized);
    const others = existing.filter((account) => account.id !== row.user_id);
    if (others.length >= options.settings.maxPerEmail) return { status: 'account_limit' as const };
    await useEmailToken(trx, row.id, options.now);
    await trx
      .updateTable('users')
      .set({
        email: row.email,
        email_normalized: row.email_normalized,
        email_verified_at: options.now,
        updated_at: options.now,
      })
      .where('id', '=', row.user_id)
      .execute();
    await activateVerifiedEmail(trx, row.user_id, options.now);
    return { status: 'confirmed' as const, userId: row.user_id, email: row.email };
  });
}

export function revertEmailChange(
  db: Kysely<Database>,
  options: { token: string; settings: EmailChangeSettings; now: Date },
): Promise<RevertEmailChangeResult> {
  return db.transaction().execute(async (trx) => {
    const taken = await takeEmailToken(trx, options.token, 'email_revert', options.now);
    if (taken.status === 'invalid') return taken;
    const { row } = taken;
    if (row.user_id === null) return { status: 'invalid' as const, reason: 'unknown' as const };
    await lockEmail(trx, row.email_normalized);
    const existing = await accountsWithEmail(trx, row.email_normalized);
    const others = existing.filter((account) => account.id !== row.user_id);
    if (others.length >= options.settings.maxPerEmail) return { status: 'account_limit' as const };
    await useEmailToken(trx, row.id, options.now);
    await trx
      .updateTable('email_tokens')
      .set({ used_at: options.now })
      .where('user_id', '=', row.user_id)
      .where('purpose', '=', 'email_change')
      .where('used_at', 'is', null)
      .execute();
    await trx
      .updateTable('users')
      .set({
        email: row.email,
        email_normalized: row.email_normalized,
        email_verified_at: options.now,
        updated_at: options.now,
      })
      .where('id', '=', row.user_id)
      .execute();
    await activateVerifiedEmail(trx, row.user_id, options.now);
    return { status: 'reverted' as const, userId: row.user_id, email: row.email };
  });
}
