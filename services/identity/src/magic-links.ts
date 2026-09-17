import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { AgeBand } from '@qtiauth/service-kit';
import type { Kysely, Selectable } from 'kysely';

import {
  type AccountSummary,
  accountsWithEmail,
  createUser,
  initialAccountState,
  lockEmail,
  markEmailVerified,
  recordIdentityUse,
} from './accounts.ts';
import { type AgeBands, ageBand, ageOn } from './age.ts';
import type { Database, EmailTokenPurpose, EmailTokensTable } from './database.ts';
import { type UserCreatedData, userCreatedEvent } from './events.ts';
import {
  type CreatedSession,
  createSession,
  type SessionClient,
  type SessionSettings,
} from './sessions.ts';
import { hashToken, isToken, newToken } from './tokens.ts';

export const MAGIC_LINK_METHOD = 'magic_link';
export const MAGIC_LINK_AMR = ['email'];

export interface MagicLinkSettings {
  ttl: number;
  signupTtl: number;
  maxPerEmail: number;
  consentAge: number;
  bands: AgeBands;
  normalizeEmail: (address: string) => string;
  sessions: SessionSettings;
}

export type TokenFailure = 'unknown' | 'used' | 'expired';

export type VerifyResult =
  | { status: 'invalid'; reason: TokenFailure }
  | { status: 'choose_account'; accounts: AccountSummary[] }
  | { status: 'signup_required'; signupToken: string; expiresAt: Date }
  | { status: 'signed_in'; userId: string; session: CreatedSession; returnTo: string | null };

export type SignupResult =
  | { status: 'invalid'; reason: TokenFailure }
  | { status: 'account_limit' }
  | { status: 'parental_consent_required' }
  | {
      status: 'signed_in';
      userId: string;
      ageBand: AgeBand;
      session: CreatedSession;
      returnTo: string | null;
    };

type TokenRow = Selectable<EmailTokensTable>;

async function insertToken(
  db: Kysely<Database>,
  token: {
    purpose: EmailTokenPurpose;
    email: string;
    emailNormalized: string;
    locale: string | null;
    returnTo: string | null;
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
      created_at: token.now,
      expires_at: token.expiresAt,
    })
    .execute();
  return value;
}

async function takeToken(
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

async function useToken(trx: Kysely<Database>, id: string, now: Date): Promise<void> {
  await trx.updateTable('email_tokens').set({ used_at: now }).where('id', '=', id).execute();
}

export async function issueMagicLink(
  db: Kysely<Database>,
  options: {
    email: string;
    locale: string | null;
    returnTo: string | null;
    settings: MagicLinkSettings;
    now: Date;
  },
): Promise<{ token: string; expiresAt: Date }> {
  const { settings, now } = options;
  const expiresAt = new Date(now.getTime() + settings.ttl);
  const token = await insertToken(db, {
    purpose: 'magic_link',
    email: options.email.trim(),
    emailNormalized: settings.normalizeEmail(options.email),
    locale: options.locale,
    returnTo: options.returnTo,
    expiresAt,
    now,
  });
  return { token, expiresAt };
}

export function verifyMagicLink(
  db: Kysely<Database>,
  options: {
    token: string;
    userId: string | undefined;
    client: SessionClient;
    settings: MagicLinkSettings;
    now: Date;
  },
): Promise<VerifyResult> {
  const { settings, now } = options;
  return db.transaction().execute(async (trx): Promise<VerifyResult> => {
    const taken = await takeToken(trx, options.token, 'magic_link', now);
    if (taken.status === 'invalid') return taken;
    const { row } = taken;

    const accounts = await accountsWithEmail(trx, row.email_normalized);
    if (accounts.length === 0) {
      await useToken(trx, row.id, now);
      const expiresAt = new Date(now.getTime() + settings.signupTtl);
      const signupToken = await insertToken(trx, {
        purpose: 'signup',
        email: row.email,
        emailNormalized: row.email_normalized,
        locale: row.locale,
        returnTo: row.return_to,
        expiresAt,
        now,
      });
      return { status: 'signup_required', signupToken, expiresAt };
    }

    const account =
      accounts.length === 1 && options.userId === undefined
        ? accounts[0]
        : accounts.find((candidate) => candidate.id === options.userId);
    if (!account) return { status: 'choose_account', accounts };

    await useToken(trx, row.id, now);
    await markEmailVerified(trx, account.id, now);
    await recordIdentityUse(trx, account.id, MAGIC_LINK_METHOD, now);
    const session = await createSession(trx, {
      userId: account.id,
      authMethod: MAGIC_LINK_METHOD,
      amr: MAGIC_LINK_AMR,
      acr: 'aal1',
      client: options.client,
      settings: settings.sessions,
      now,
    });
    return { status: 'signed_in', userId: account.id, session, returnTo: row.return_to };
  });
}

export function completeSignup(
  db: Kysely<Database>,
  options: {
    signupToken: string;
    dateOfBirth: string;
    client: SessionClient;
    settings: MagicLinkSettings;
    now: Date;
  },
): Promise<SignupResult> {
  const { settings, now } = options;
  return db.transaction().execute(async (trx): Promise<SignupResult> => {
    const taken = await takeToken(trx, options.signupToken, 'signup', now);
    if (taken.status === 'invalid') return taken;
    const { row } = taken;

    const age = ageOn(options.dateOfBirth, now);
    const state = initialAccountState({
      emailVerified: true,
      age,
      consentAge: settings.consentAge,
    });
    if (state === 'pending_parental_consent') {
      await useToken(trx, row.id, now);
      return { status: 'parental_consent_required' };
    }

    await lockEmail(trx, row.email_normalized);
    const existing = await accountsWithEmail(trx, row.email_normalized);
    if (existing.length >= settings.maxPerEmail) return { status: 'account_limit' };

    await useToken(trx, row.id, now);
    const userId = await createUser(trx, {
      state,
      email: row.email,
      emailNormalized: row.email_normalized,
      emailVerifiedAt: now,
      dateOfBirth: options.dateOfBirth,
      locale: row.locale,
    });
    await recordIdentityUse(trx, userId, MAGIC_LINK_METHOD, now);
    const band = ageBand(age, settings.bands);
    await writeEvent<Database, UserCreatedData>(
      trx,
      userCreatedEvent(userId, {
        signup_method: MAGIC_LINK_METHOD,
        account_state: state,
        age_band: band,
      }),
    );
    const session = await createSession(trx, {
      userId,
      authMethod: MAGIC_LINK_METHOD,
      amr: MAGIC_LINK_AMR,
      acr: 'aal1',
      client: options.client,
      settings: settings.sessions,
      now,
    });
    return { status: 'signed_in', userId, ageBand: band, session, returnTo: row.return_to };
  });
}

export async function sweepTokens(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<number> {
  const result = await db
    .deleteFrom('email_tokens')
    .where('expires_at', '<', new Date(options.now.getTime() - options.retention))
    .execute();
  return result.reduce((total, row) => total + Number(row.numDeletedRows), 0);
}
