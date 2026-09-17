import { writeEvent } from '@qtiauth/bus';
import type { AgeBand } from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import {
  accountsWithEmail,
  activateVerifiedEmail,
  createUser,
  findAccount,
  findPasswordIdentity,
  initialAccountState,
  lockEmail,
  recordIdentityUse,
  upsertPassword,
} from './accounts.ts';
import { type AgeBands, ageBand, ageOn } from './age.ts';
import { insertChallenge } from './challenges.ts';
import type { Database } from './database.ts';
import {
  insertEmailToken,
  takeEmailToken,
  type TokenFailure,
  useEmailToken,
} from './email-tokens.ts';
import { type UserCreatedData, userCreatedEvent } from './events.ts';
import { hasSecondFactor, type SecondFactorMethod, secondFactorMethods } from './factors.ts';
import {
  clearAuthFailures,
  countedFailures,
  type FailureDelaySettings,
  failureWait,
  recordAuthFailure,
  wait,
} from './failures.ts';
import { MAGIC_LINK_METHOD } from './magic-links.ts';
import {
  type Argon2Params,
  checkBreachedPassword,
  dummyPasswordHash,
  emailLocalPart,
  hashPassword,
  needsRehash,
  PASSWORD_AMR,
  PASSWORD_METHOD,
  type PasswordPolicy,
  type PasswordPolicyReason,
  passwordPolicyReason,
  verifyPassword,
} from './passwords.ts';
import {
  type CreatedSession,
  createSession,
  loadSession,
  revokeSessions,
  type SessionClient,
  type SessionSettings,
} from './sessions.ts';

export interface PasswordSettings {
  policy: PasswordPolicy;
  argon2: Argon2Params;
  breachCheck: boolean;
  resetTtl: number;
  verificationTtl: number;
  failureDelay: FailureDelaySettings;
  maxPerEmail: number;
  consentAge: number;
  bands: AgeBands;
  stepUpWindow: number;
  normalizeEmail: (address: string) => string;
  sessions: SessionSettings;
}

export type PasswordSignupResult =
  | { status: 'account_limit' }
  | { status: 'parental_consent_required' }
  | { status: 'rejected'; reason: PasswordPolicyReason }
  | { status: 'created'; userId: string; ageBand: AgeBand; verifyToken: string; expiresAt: Date };

export type PasswordLoginResult =
  | { status: 'invalid' }
  | {
      status: 'signed_in';
      userId: string;
      session: CreatedSession;
      rehashed: boolean;
    }
  | {
      status: 'second_factor_required';
      userId: string;
      challenge: string;
      methods: SecondFactorMethod[];
      expiresAt: Date;
      rehashed: boolean;
    };

export interface PasswordResetStartResult {
  token: string;
  expiresAt: Date;
}

export type ConsumeResetResult =
  | { status: 'invalid'; reason: TokenFailure }
  | { status: 'choose_account'; accounts: { id: string; created_at: Date }[] }
  | { status: 'ready'; email: string; token: string; userId: string };

export type PasswordResetResult =
  | { status: 'invalid'; reason: TokenFailure }
  | { status: 'choose_account'; accounts: { id: string; created_at: Date }[] }
  | { status: 'rejected'; reason: PasswordPolicyReason }
  | { status: 'signed_in'; userId: string; session: CreatedSession; revoked: string[] };

export interface EmailVerifyStartResult {
  sent: boolean;
  token?: string;
  expiresAt?: Date;
}

export type EmailVerifyResult =
  | { status: 'invalid'; reason: TokenFailure }
  | { status: 'signed_in'; userId: string; session: CreatedSession };

export type SetPasswordResult =
  | { status: 'rejected'; reason: PasswordPolicyReason }
  | { status: 'current_required' }
  | { status: 'current_incorrect' }
  | { status: 'step_up_required' }
  | { status: 'not_found' }
  | { status: 'updated'; added: boolean };

function identifiers(email: string, username?: string | null): (string | null | undefined)[] {
  return [emailLocalPart(email), username];
}

async function rejectIfUnusable(
  password: string,
  email: string,
  settings: PasswordSettings,
  extraIdentifiers: readonly (string | null | undefined)[] = [],
): Promise<PasswordPolicyReason | undefined> {
  const reason = passwordPolicyReason(password, settings.policy, [
    ...identifiers(email),
    ...extraIdentifiers,
  ]);
  if (reason !== undefined) return reason;
  if (!settings.breachCheck) return undefined;
  const breached = await checkBreachedPassword(password);
  return breached === 'rejected' ? 'breached' : undefined;
}

async function passwordRows(
  db: Kysely<Database>,
  userIds: readonly string[],
): Promise<{ user_id: string; secret: string }[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .selectFrom('identities')
    .select(['user_id', 'secret'])
    .where('type', '=', PASSWORD_METHOD)
    .where('subject', 'is', null)
    .where('user_id', 'in', [...userIds])
    .execute();
  return rows.flatMap((row) =>
    row.secret === null ? [] : [{ user_id: row.user_id, secret: row.secret }],
  );
}

export async function completePasswordSignup(
  db: Kysely<Database>,
  options: {
    email: string;
    password: string;
    dateOfBirth: string;
    locale: string | null;
    settings: PasswordSettings;
    now: Date;
  },
): Promise<PasswordSignupResult> {
  const { settings, now } = options;
  const email = options.email.trim();
  const rejected = await rejectIfUnusable(options.password, email, settings);
  if (rejected !== undefined) return { status: 'rejected', reason: rejected };

  const age = ageOn(options.dateOfBirth, now);
  const state = initialAccountState({
    emailVerified: false,
    age,
    consentAge: settings.consentAge,
  });
  if (state === 'pending_parental_consent') return { status: 'parental_consent_required' };

  const emailNormalized = settings.normalizeEmail(email);
  const hash = await hashPassword(options.password, settings.argon2);
  return db.transaction().execute(async (trx): Promise<PasswordSignupResult> => {
    await lockEmail(trx, emailNormalized);
    const existing = await accountsWithEmail(trx, emailNormalized);
    if (existing.length >= settings.maxPerEmail) return { status: 'account_limit' };

    const userId = await createUser(trx, {
      state,
      email,
      emailNormalized,
      emailVerifiedAt: null,
      dateOfBirth: options.dateOfBirth,
      locale: options.locale,
    });
    await upsertPassword(trx, userId, hash, now);
    const band = ageBand(age, settings.bands);
    await writeEvent<Database, UserCreatedData>(
      trx,
      userCreatedEvent(userId, {
        signup_method: PASSWORD_METHOD,
        account_state: state,
        age_band: band,
      }),
    );
    const expiresAt = new Date(now.getTime() + settings.verificationTtl);
    const verifyToken = await insertEmailToken(trx, {
      purpose: 'email_verify',
      email,
      emailNormalized,
      locale: options.locale,
      returnTo: null,
      userId,
      expiresAt,
      now,
    });
    return { status: 'created', userId, ageBand: band, verifyToken, expiresAt };
  });
}

export async function loginWithPassword(
  db: Kysely<Database>,
  options: {
    email: string;
    password: string;
    ip: string;
    client: SessionClient;
    settings: PasswordSettings;
    now: Date;
  },
): Promise<PasswordLoginResult> {
  const { settings, now } = options;
  const accountKey = settings.normalizeEmail(options.email);
  const keys = { ip: options.ip, account: accountKey };
  const accounts = await accountsWithEmail(db, accountKey);
  const hashes = await passwordRows(
    db,
    accounts.map((account) => account.id),
  );
  const dummy = await dummyPasswordHash(settings.argon2);
  const candidates = hashes.length > 0 ? hashes : [{ user_id: '', secret: dummy }];

  let matched: { user_id: string; secret: string } | undefined;
  for (const candidate of candidates) {
    if ((await verifyPassword(options.password, candidate.secret)) && candidate.user_id !== '') {
      matched = candidate;
    }
  }

  await wait(failureWait(await countedFailures(db, keys), settings.failureDelay));

  if (matched === undefined) {
    await recordAuthFailure(db, keys, now);
    return { status: 'invalid' };
  }

  let rehashed = false;
  let secret = matched.secret;
  if (needsRehash(secret, settings.argon2)) {
    secret = await hashPassword(options.password, settings.argon2);
    rehashed = true;
  }

  const signedIn = await db.transaction().execute(async (trx) => {
    const account = await findAccount(trx, matched.user_id);
    if (!account || account.state === 'deleted') return undefined;
    if (rehashed) await upsertPassword(trx, account.id, secret, now);
    await recordIdentityUse(trx, account.id, PASSWORD_METHOD, now);
    // Anything that counts as enrolment for security.require_2fa_for_permissions
    // has to be asked for here too, or a passkey-only account would satisfy the
    // enrolment gate and still never be challenged.
    if (await hasSecondFactor(trx, account.id)) {
      const methods = await secondFactorMethods(trx, account.id);
      const challenge = await insertChallenge(trx, {
        kind: 'second_factor',
        userId: account.id,
        payload: { methods, amr: PASSWORD_AMR, authMethod: PASSWORD_METHOD },
        now,
      });
      return {
        status: 'second_factor_required' as const,
        userId: account.id,
        challenge: challenge.token,
        methods,
        expiresAt: challenge.expiresAt,
      };
    }
    const session = await createSession(trx, {
      userId: account.id,
      authMethod: PASSWORD_METHOD,
      amr: PASSWORD_AMR,
      acr: 'aal1',
      client: options.client,
      settings: settings.sessions,
      now,
    });
    return { status: 'signed_in' as const, userId: account.id, session };
  });

  if (signedIn === undefined) {
    await recordAuthFailure(db, keys, now);
    return { status: 'invalid' };
  }
  await clearAuthFailures(db, keys);
  return { ...signedIn, rehashed };
}

export async function issuePasswordReset(
  db: Kysely<Database>,
  options: {
    email: string;
    locale: string | null;
    settings: PasswordSettings;
    now: Date;
  },
): Promise<PasswordResetStartResult> {
  const { settings, now } = options;
  const email = options.email.trim();
  const expiresAt = new Date(now.getTime() + settings.resetTtl);
  const token = await insertEmailToken(db, {
    purpose: 'password_reset',
    email,
    emailNormalized: settings.normalizeEmail(email),
    locale: options.locale,
    returnTo: null,
    userId: null,
    expiresAt,
    now,
  });
  return { token, expiresAt };
}

export function consumePasswordReset(
  db: Kysely<Database>,
  options: { token: string; userId: string | undefined; settings: PasswordSettings; now: Date },
): Promise<ConsumeResetResult> {
  return db.transaction().execute(async (trx): Promise<ConsumeResetResult> => {
    const taken = await takeEmailToken(trx, options.token, 'password_reset', options.now);
    if (taken.status === 'invalid') return taken;
    const accounts = (await accountsWithEmail(trx, taken.row.email_normalized)).filter(
      (account) => account.state !== 'deleted',
    );
    if (accounts.length === 0) return { status: 'invalid', reason: 'unknown' };
    if (accounts.length > 1 && options.userId === undefined) {
      return { status: 'choose_account', accounts };
    }
    const account =
      accounts.length === 1 && options.userId === undefined
        ? accounts[0]
        : accounts.find((candidate) => candidate.id === options.userId);
    if (!account) return { status: 'choose_account', accounts };
    return { status: 'ready', email: taken.row.email, token: options.token, userId: account.id };
  });
}

export async function resetPassword(
  db: Kysely<Database>,
  options: {
    token: string;
    password: string;
    keepOtherSessions: boolean;
    userId: string | undefined;
    client: SessionClient;
    settings: PasswordSettings;
    now: Date;
  },
): Promise<PasswordResetResult> {
  const { settings, now } = options;
  const peeked = await consumePasswordReset(db, {
    token: options.token,
    userId: options.userId,
    settings,
    now,
  });
  if (peeked.status !== 'ready') return peeked;
  const resetAccount = await findAccount(db, peeked.userId);
  const rejected = await rejectIfUnusable(options.password, peeked.email, settings, [
    resetAccount?.username,
  ]);
  if (rejected !== undefined) return { status: 'rejected', reason: rejected };
  const hash = await hashPassword(options.password, settings.argon2);

  return db.transaction().execute(async (trx): Promise<PasswordResetResult> => {
    const taken = await takeEmailToken(trx, options.token, 'password_reset', now);
    if (taken.status === 'invalid') return taken;
    const accounts = await accountsWithEmail(trx, taken.row.email_normalized);
    const account =
      accounts.length === 1 && options.userId === undefined
        ? accounts[0]
        : accounts.find((candidate) => candidate.id === options.userId);
    if (!account) return { status: 'choose_account', accounts };
    await useEmailToken(trx, taken.row.id, now);
    await upsertPassword(trx, account.id, hash, now);
    await recordIdentityUse(trx, account.id, PASSWORD_METHOD, now);
    const session = await createSession(trx, {
      userId: account.id,
      authMethod: PASSWORD_METHOD,
      amr: PASSWORD_AMR,
      acr: 'aal1',
      client: options.client,
      settings: settings.sessions,
      now,
    });
    const revoked = options.keepOtherSessions
      ? []
      : await revokeSessions(trx, {
          userId: account.id,
          reason: 'revoked',
          now,
          except: session.id,
        });
    return { status: 'signed_in', userId: account.id, session, revoked };
  });
}

export async function issueEmailVerification(
  db: Kysely<Database>,
  options: {
    email: string;
    locale: string | null;
    settings: PasswordSettings;
    now: Date;
  },
): Promise<EmailVerifyStartResult> {
  const { settings, now } = options;
  const emailNormalized = settings.normalizeEmail(options.email);
  const pending = (await accountsWithEmail(db, emailNormalized)).filter(
    (account) => account.state === 'pending_email_verification',
  );
  if (pending.length === 0) return { sent: false };
  const account = pending[0];
  if (account === undefined) return { sent: false };
  const full = await findAccount(db, account.id);
  const expiresAt = new Date(now.getTime() + settings.verificationTtl);
  const token = await insertEmailToken(db, {
    purpose: 'email_verify',
    email: full?.email ?? options.email.trim(),
    emailNormalized,
    locale: full?.locale ?? options.locale,
    returnTo: null,
    userId: account.id,
    expiresAt,
    now,
  });
  return { sent: true, token, expiresAt };
}

export function verifyEmailAddress(
  db: Kysely<Database>,
  options: {
    token: string;
    client: SessionClient;
    settings: PasswordSettings;
    now: Date;
  },
): Promise<EmailVerifyResult> {
  const { settings, now } = options;
  return db.transaction().execute(async (trx): Promise<EmailVerifyResult> => {
    const taken = await takeEmailToken(trx, options.token, 'email_verify', now);
    if (taken.status === 'invalid') return taken;
    const userId = taken.row.user_id;
    if (userId === null) return { status: 'invalid', reason: 'unknown' };
    await useEmailToken(trx, taken.row.id, now);
    const account = await activateVerifiedEmail(trx, userId, now);
    if (!account || account.state === 'deleted') return { status: 'invalid', reason: 'unknown' };
    const session = await createSession(trx, {
      userId: account.id,
      authMethod: PASSWORD_METHOD,
      amr: PASSWORD_AMR,
      acr: 'aal1',
      client: options.client,
      settings: settings.sessions,
      now,
    });
    return { status: 'signed_in', userId: account.id, session };
  });
}

function recentStepUp(
  session: { auth_method: string; created_at: Date; acr: string; step_up_at: Date | null },
  window: number,
  now: Date,
): boolean {
  if (session.acr === 'aal2' && session.step_up_at !== null) {
    return now.getTime() - session.step_up_at.getTime() <= window;
  }
  return (
    session.auth_method === MAGIC_LINK_METHOD &&
    now.getTime() - session.created_at.getTime() <= window
  );
}

export async function setAccountPassword(
  db: Kysely<Database>,
  options: {
    userId: string;
    sessionId: string;
    password: string;
    currentPassword: string | undefined;
    settings: PasswordSettings;
    now: Date;
  },
): Promise<SetPasswordResult> {
  const { settings, now } = options;
  const account = await findAccount(db, options.userId);
  if (!account || account.state === 'deleted') return { status: 'not_found' };
  const existing = await findPasswordIdentity(db, options.userId);
  const hasPassword = existing?.secret !== undefined && existing.secret !== null;

  if (hasPassword) {
    if (options.currentPassword === undefined) return { status: 'current_required' };
    if (!(await verifyPassword(options.currentPassword, existing.secret ?? ''))) {
      return { status: 'current_incorrect' };
    }
  } else {
    const session = await loadSession(db, { sessionId: options.sessionId, userId: options.userId });
    if (!session || !recentStepUp(session, settings.stepUpWindow, now)) {
      return { status: 'step_up_required' };
    }
  }

  const rejected = await rejectIfUnusable(options.password, account.email, settings, [
    account.username,
  ]);
  if (rejected !== undefined) return { status: 'rejected', reason: rejected };
  if (hasPassword && options.currentPassword === options.password) {
    return { status: 'updated', added: false };
  }
  const hash = await hashPassword(options.password, settings.argon2);
  await upsertPassword(db, options.userId, hash, now);
  return { status: 'updated', added: !hasPassword };
}
