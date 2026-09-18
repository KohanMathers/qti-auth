import { writeEvent } from '@qtiauth/bus';
import type { AgeBand } from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import {
  type AccountSummary,
  accountsWithEmail,
  createUser,
  initialAccountState,
  lockEmail,
  markEmailVerified,
  recordIdentityUse,
} from './accounts.ts';
import { type AgeBands, ageBand, ageOn, agePrivacyDefaults, under18 } from './age.ts';
import { recordSignupAgeAssurance } from './age-assurance.ts';
import type { Database } from './database.ts';
import { recordCurrentLegalAcceptances } from './legal.ts';
import {
  insertEmailToken,
  takeEmailToken,
  type TokenFailure,
  useEmailToken,
} from './email-tokens.ts';
import { type UserCreatedData, userCreatedEvent } from './events.ts';
import { assignAdminIfFirst } from './roles.ts';
import {
  type CreatedSession,
  createSession,
  type SessionClient,
  type SessionSettings,
} from './sessions.ts';

export const MAGIC_LINK_METHOD = 'magic_link';
export const MAGIC_LINK_AMR = ['email'];
export type { TokenFailure };

export interface MagicLinkSettings {
  ttl: number;
  signupTtl: number;
  maxPerEmail: number;
  consentAge: number;
  bands: AgeBands;
  defaultProvider: string;
  requiredFor: readonly string[];
  normalizeEmail: (address: string) => string;
  sessions: SessionSettings;
}

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
  const token = await insertEmailToken(db, {
    purpose: 'magic_link',
    email: options.email.trim(),
    emailNormalized: settings.normalizeEmail(options.email),
    locale: options.locale,
    returnTo: options.returnTo,
    userId: null,
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
    const taken = await takeEmailToken(trx, options.token, ['magic_link', 'admin_signup'], now);
    if (taken.status === 'invalid') return taken;
    const { row } = taken;
    const adminInvite = row.purpose === 'admin_signup';

    const accounts = await accountsWithEmail(trx, row.email_normalized);
    if (accounts.length === 0) {
      await useEmailToken(trx, row.id, now);
      const expiresAt = new Date(now.getTime() + settings.signupTtl);
      const signupToken = await insertEmailToken(trx, {
        purpose: adminInvite ? 'admin_signup' : 'signup',
        email: row.email,
        emailNormalized: row.email_normalized,
        locale: row.locale,
        returnTo: row.return_to,
        userId: null,
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

    await useEmailToken(trx, row.id, now);
    await markEmailVerified(trx, account.id, now);
    await recordIdentityUse(trx, account.id, MAGIC_LINK_METHOD, now);
    if (adminInvite) await assignAdminIfFirst(trx, account.id);
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
    const taken = await takeEmailToken(trx, options.signupToken, ['signup', 'admin_signup'], now);
    if (taken.status === 'invalid') return taken;
    const { row } = taken;
    const adminInvite = row.purpose === 'admin_signup';

    const age = ageOn(options.dateOfBirth, now);
    const state = initialAccountState({
      emailVerified: true,
      age,
      consentAge: settings.consentAge,
    });
    if (state === 'pending_parental_consent') {
      await useEmailToken(trx, row.id, now);
      return { status: 'parental_consent_required' };
    }

    await lockEmail(trx, row.email_normalized);
    const existing = await accountsWithEmail(trx, row.email_normalized);
    if (existing.length >= settings.maxPerEmail) return { status: 'account_limit' };

    await useEmailToken(trx, row.id, now);
    const privacy = agePrivacyDefaults(under18(age, settings.bands));
    const userId = await createUser(trx, {
      state,
      email: row.email,
      emailNormalized: row.email_normalized,
      emailVerifiedAt: now,
      dateOfBirth: options.dateOfBirth,
      locale: row.locale,
      ...privacy,
    });
    await recordIdentityUse(trx, userId, MAGIC_LINK_METHOD, now);
    if (adminInvite) await assignAdminIfFirst(trx, userId);
    const band = ageBand(age, settings.bands);
    await recordSignupAgeAssurance(trx, {
      userId,
      adult: band === 'adult',
      defaultProvider: settings.defaultProvider,
      requiredFor: settings.requiredFor,
      now,
    });
    await recordCurrentLegalAcceptances(trx, {
      userId,
      ip: options.client.ip || null,
      method: 'signup',
      now,
    });
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
