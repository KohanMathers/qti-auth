import { writeEvent } from '@qtiauth/bus';
import type { Kysely } from 'kysely';

import { accountsWithEmail, activateVerifiedEmail, findAccount, lockEmail } from './accounts.ts';
import type { Database, EmailTokenPurpose } from './database.ts';
import {
  insertEmailToken,
  takeEmailToken,
  type TokenFailure,
  useEmailToken,
} from './email-tokens.ts';
import { type AuditRecordedData, auditRecordedEvent } from './events.ts';

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

/**
 * Moves the account to the address the token carries. Both directions of an
 * email change do the same work: take the link, check the address still has room
 * for this account, and set it. Reverting also cancels any confirmation still
 * outstanding, so the change cannot be re-applied after the user undid it.
 */
async function applyEmailToken(
  db: Kysely<Database>,
  options: {
    token: string;
    purpose: Extract<EmailTokenPurpose, 'email_change' | 'email_revert'>;
    settings: EmailChangeSettings;
    now: Date;
  },
): Promise<
  | { status: 'invalid'; reason: TokenFailure }
  | { status: 'account_limit' }
  | { status: 'applied'; userId: string; email: string }
> {
  return db.transaction().execute(async (trx) => {
    const taken = await takeEmailToken(trx, options.token, options.purpose, options.now);
    if (taken.status === 'invalid') return taken;
    const { row } = taken;
    if (row.user_id === null) return { status: 'invalid' as const, reason: 'unknown' as const };
    const userId = row.user_id;
    await lockEmail(trx, row.email_normalized);
    const existing = await accountsWithEmail(trx, row.email_normalized);
    const others = existing.filter((account) => account.id !== userId);
    if (others.length >= options.settings.maxPerEmail) return { status: 'account_limit' as const };
    await useEmailToken(trx, row.id, options.now);
    if (options.purpose === 'email_revert') {
      await trx
        .updateTable('email_tokens')
        .set({ used_at: options.now })
        .where('user_id', '=', userId)
        .where('purpose', '=', 'email_change')
        .where('used_at', 'is', null)
        .execute();
    }
    await trx
      .updateTable('users')
      .set({
        email: row.email,
        email_normalized: row.email_normalized,
        email_verified_at: options.now,
        updated_at: options.now,
      })
      .where('id', '=', userId)
      .execute();
    await activateVerifiedEmail(trx, userId, options.now);
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(
        { type: 'user', id: userId },
        {
          action: options.purpose === 'email_revert' ? 'user.email.reverted' : 'user.email.changed',
          target_type: 'user',
          target_id: userId,
        },
      ),
    );
    return { status: 'applied' as const, userId, email: row.email };
  });
}

export async function confirmEmailChange(
  db: Kysely<Database>,
  options: { token: string; settings: EmailChangeSettings; now: Date },
): Promise<ConfirmEmailChangeResult> {
  const result = await applyEmailToken(db, { ...options, purpose: 'email_change' });
  if (result.status !== 'applied') return result;
  return { status: 'confirmed', userId: result.userId, email: result.email };
}

export async function revertEmailChange(
  db: Kysely<Database>,
  options: { token: string; settings: EmailChangeSettings; now: Date },
): Promise<RevertEmailChangeResult> {
  const result = await applyEmailToken(db, { ...options, purpose: 'email_revert' });
  if (result.status !== 'applied') return result;
  return { status: 'reverted', userId: result.userId, email: result.email };
}
