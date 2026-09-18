import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import { updatedRows } from '@qtiauth/db';
import type { EventActor } from '@qtiauth/events';
import { sql, type Kysely } from 'kysely';

import { assertTransition, findAccount } from './accounts.ts';
import { type AgeBands, ageOn } from './age.ts';
import type { Database, ParentalConsentStatus } from './database.ts';
import {
  insertEmailToken,
  invalidateEmailTokens,
  takeEmailToken,
  type TokenFailure,
  useEmailToken,
} from './email-tokens.ts';
import {
  type AuditRecordedData,
  auditRecordedEvent,
  type ParentalConsentRequestedData,
  parentalConsentGrantedEvent,
  parentalConsentRequestedEvent,
  type UserDeletedData,
  type UserUpdatedData,
  userDeletedEvent,
  userUpdatedEvent,
} from './events.ts';
import { recordCurrentLegalAcceptances } from './legal.ts';
import { hasActiveHold } from './legal-holds.ts';

export const EXPIRE_PENDING_JOB = 'parental.expire_pending';
export const MAX_GUARDIAN_EMAIL_CHANGES = 3;
export const CHILDREN_SUMMARY_ID = 'children-summary';
export const CONSENT_TOKEN_PURPOSES = ['parental_approve', 'parental_decline'] as const;

export interface ParentalSettings {
  consentAge: number;
  pendingTtl: number;
  bands: AgeBands;
  normalizeEmail: (address: string) => string;
}

export interface ParentalConsent {
  id: string;
  user_id: string;
  guardian_email: string;
  guardian_email_normalized: string;
  guardian_date_of_birth: string | null;
  email_changes: number;
  status: ParentalConsentStatus;
  requested_at: Date;
  decided_at: Date | null;
}

export interface ConsentLinks {
  email: string;
  locale: string | null;
  approveToken: string;
  declineToken: string;
  expiresAt: Date;
}

export interface PresentedConsent {
  guardian_email: string;
  email_changes_remaining: number;
  expires_at: string;
}

export type GuardianEmailProblem = 'required' | 'invalid' | 'same_as_child';

export type ChangeGuardianEmailResult =
  | { status: 'ok'; links: ConsentLinks }
  | { status: 'not_pending' }
  | { status: 'unchanged' }
  | { status: 'limit' }
  | { status: 'invalid' };

export type ResendConsentResult = { status: 'ok'; links: ConsentLinks } | { status: 'not_pending' };

export type ApproveConsentResult =
  | { status: 'ok'; userId: string }
  | { status: 'invalid'; reason: TokenFailure }
  | { status: 'not_adult' };

export type DeclineConsentResult =
  { status: 'ok'; userId: string } | { status: 'invalid'; reason: TokenFailure };

const guardianDobColumn = sql<string | null>`
  case when parental_consents.guardian_date_of_birth is null then null
  else to_char(parental_consents.guardian_date_of_birth, 'YYYY-MM-DD') end
`;

export function needsParentalConsent(age: number, consentAge: number): boolean {
  return age < consentAge;
}

export function guardianEmailProblem(
  guardianEmail: string | undefined,
  childNormalized: string,
  normalizeEmail: (address: string) => string,
): GuardianEmailProblem | undefined {
  const trimmed = guardianEmail?.trim() ?? '';
  if (trimmed === '') return 'required';
  if (!trimmed.includes('@')) return 'invalid';
  const normalized = normalizeEmail(trimmed);
  if (normalized === childNormalized) return 'same_as_child';
  return undefined;
}

export function consentExpiresAt(requestedAt: Date, pendingTtl: number): Date {
  return new Date(requestedAt.getTime() + pendingTtl);
}

function selectConsent(db: Kysely<Database>) {
  return db
    .selectFrom('parental_consents')
    .select([
      'id',
      'user_id',
      'guardian_email',
      'guardian_email_normalized',
      guardianDobColumn.as('guardian_date_of_birth'),
      'email_changes',
      'status',
      'requested_at',
      'decided_at',
    ]);
}

export function findPendingConsent(
  db: Kysely<Database>,
  userId: string,
): Promise<ParentalConsent | undefined> {
  return selectConsent(db)
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
}

export function listConsents(db: Kysely<Database>, userId: string): Promise<ParentalConsent[]> {
  return selectConsent(db)
    .where('user_id', '=', userId)
    .orderBy('requested_at')
    .orderBy('id')
    .execute();
}

export function presentConsent(row: ParentalConsent, pendingTtl: number): PresentedConsent {
  return {
    guardian_email: row.guardian_email,
    email_changes_remaining: Math.max(0, MAX_GUARDIAN_EMAIL_CHANGES - row.email_changes),
    expires_at: consentExpiresAt(row.requested_at, pendingTtl).toISOString(),
  };
}

export async function createPendingConsent(
  db: Kysely<Database>,
  options: {
    userId: string;
    email: string;
    emailNormalized: string;
    now: Date;
  },
): Promise<ParentalConsent> {
  const id = randomUUIDv7();
  await db
    .insertInto('parental_consents')
    .values({
      id,
      user_id: options.userId,
      guardian_email: options.email.trim(),
      guardian_email_normalized: options.emailNormalized,
      guardian_date_of_birth: null,
      email_changes: 0,
      status: 'pending',
      requested_at: options.now,
      decided_at: null,
      created_at: options.now,
      updated_at: options.now,
    })
    .execute();
  return {
    id,
    user_id: options.userId,
    guardian_email: options.email.trim(),
    guardian_email_normalized: options.emailNormalized,
    guardian_date_of_birth: null,
    email_changes: 0,
    status: 'pending',
    requested_at: options.now,
    decided_at: null,
  };
}

export async function issueConsentLinks(
  db: Kysely<Database>,
  options: {
    userId: string;
    locale: string | null;
    pendingTtl: number;
    now: Date;
  },
): Promise<ConsentLinks | undefined> {
  const row = await findPendingConsent(db, options.userId);
  if (!row) return undefined;
  const expiresAt = consentExpiresAt(row.requested_at, options.pendingTtl);
  if (expiresAt <= options.now) return undefined;
  await invalidateEmailTokens(db, {
    userId: options.userId,
    purposes: CONSENT_TOKEN_PURPOSES,
    now: options.now,
  });
  const approveToken = await insertEmailToken(db, {
    purpose: 'parental_approve',
    email: row.guardian_email,
    emailNormalized: row.guardian_email_normalized,
    locale: options.locale,
    returnTo: null,
    userId: options.userId,
    expiresAt,
    now: options.now,
  });
  const declineToken = await insertEmailToken(db, {
    purpose: 'parental_decline',
    email: row.guardian_email,
    emailNormalized: row.guardian_email_normalized,
    locale: options.locale,
    returnTo: null,
    userId: options.userId,
    expiresAt,
    now: options.now,
  });
  await writeEvent<Database, ParentalConsentRequestedData>(
    db,
    parentalConsentRequestedEvent(options.userId, { expires_at: expiresAt.toISOString() }),
  );
  return {
    email: row.guardian_email,
    locale: options.locale,
    approveToken,
    declineToken,
    expiresAt,
  };
}

export async function resendConsent(
  db: Kysely<Database>,
  options: {
    userId: string;
    locale: string | null;
    pendingTtl: number;
    now: Date;
  },
): Promise<ResendConsentResult> {
  return db.transaction().execute(async (trx) => {
    const links = await issueConsentLinks(trx, options);
    if (!links) return { status: 'not_pending' as const };
    return { status: 'ok' as const, links };
  });
}

export async function changeGuardianEmail(
  db: Kysely<Database>,
  options: {
    userId: string;
    email: string;
    locale: string | null;
    childNormalized: string;
    settings: ParentalSettings;
    now: Date;
  },
): Promise<ChangeGuardianEmailResult> {
  const problem = guardianEmailProblem(
    options.email,
    options.childNormalized,
    options.settings.normalizeEmail,
  );
  if (problem !== undefined) return { status: 'invalid' };
  const email = options.email.trim();
  const emailNormalized = options.settings.normalizeEmail(email);
  return db.transaction().execute(async (trx) => {
    const row = await findPendingConsent(trx, options.userId);
    if (!row) return { status: 'not_pending' as const };
    if (row.guardian_email_normalized === emailNormalized) return { status: 'unchanged' as const };
    if (row.email_changes >= MAX_GUARDIAN_EMAIL_CHANGES) return { status: 'limit' as const };
    await trx
      .updateTable('parental_consents')
      .set({
        guardian_email: email,
        guardian_email_normalized: emailNormalized,
        email_changes: row.email_changes + 1,
        updated_at: options.now,
      })
      .where('id', '=', row.id)
      .where('status', '=', 'pending')
      .execute();
    const links = await issueConsentLinks(trx, {
      userId: options.userId,
      locale: options.locale,
      pendingTtl: options.settings.pendingTtl,
      now: options.now,
    });
    if (!links) return { status: 'not_pending' as const };
    return { status: 'ok' as const, links };
  });
}

export async function approveConsent(
  db: Kysely<Database>,
  options: {
    token: string;
    dateOfBirth: string;
    ip: string | null;
    settings: ParentalSettings;
    now: Date;
  },
): Promise<ApproveConsentResult> {
  return db.transaction().execute(async (trx) => {
    const taken = await takeEmailToken(trx, options.token, 'parental_approve', options.now);
    if (taken.status === 'invalid') return taken;
    const userId = taken.row.user_id;
    if (userId === null) return { status: 'invalid' as const, reason: 'unknown' as const };
    const age = ageOn(options.dateOfBirth, options.now);
    if (age < options.settings.bands.adult) return { status: 'not_adult' as const };
    const account = await findAccount(trx, userId);
    const pending = await findPendingConsent(trx, userId);
    if (
      account?.state !== 'pending_parental_consent' ||
      pending?.guardian_email_normalized !== taken.row.email_normalized
    ) {
      return { status: 'invalid' as const, reason: 'unknown' as const };
    }
    await useEmailToken(trx, taken.row.id, options.now);
    await invalidateEmailTokens(trx, {
      userId,
      purposes: CONSENT_TOKEN_PURPOSES,
      now: options.now,
    });
    assertTransition(account.state, 'active');
    await trx
      .updateTable('parental_consents')
      .set({
        status: 'granted',
        guardian_date_of_birth: options.dateOfBirth,
        decided_at: options.now,
        updated_at: options.now,
      })
      .where('id', '=', pending.id)
      .where('status', '=', 'pending')
      .execute();
    await trx
      .updateTable('users')
      .set({ state: 'active', updated_at: options.now })
      .where('id', '=', userId)
      .where('state', '=', 'pending_parental_consent')
      .execute();
    await recordCurrentLegalAcceptances(trx, {
      userId,
      ip: options.ip,
      method: 'guardian',
      now: options.now,
    });
    const actor: EventActor = { type: 'system', id: 'identity' };
    await writeEvent<Database, Record<string, never>>(trx, parentalConsentGrantedEvent(userId));
    await writeEvent<Database, UserUpdatedData>(
      trx,
      userUpdatedEvent(userId, { fields: ['state'] }, actor),
    );
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(actor, {
        action: 'parental.consent.granted',
        target_type: 'user',
        target_id: userId,
      }),
    );
    return { status: 'ok' as const, userId };
  });
}

async function deleteUnapproved(
  trx: Kysely<Database>,
  options: {
    userId: string;
    consentId: string;
    status: 'declined' | 'expired';
    now: Date;
  },
): Promise<boolean> {
  const account = await findAccount(trx, options.userId);
  if (
    !account ||
    (account.state !== 'pending_parental_consent' && account.state !== 'pending_email_verification')
  ) {
    return false;
  }
  assertTransition(account.state, 'deleted');
  const moved = await trx
    .updateTable('users')
    .set({ state: 'deleted', updated_at: options.now })
    .where('id', '=', options.userId)
    .where('state', '=', account.state)
    .executeTakeFirst();
  if (updatedRows(moved) === 0) return false;
  await trx
    .updateTable('parental_consents')
    .set({
      status: options.status,
      decided_at: options.now,
      updated_at: options.now,
    })
    .where('id', '=', options.consentId)
    .where('status', '=', 'pending')
    .execute();
  await invalidateEmailTokens(trx, {
    userId: options.userId,
    purposes: CONSENT_TOKEN_PURPOSES,
    now: options.now,
  });
  const held = await hasActiveHold(trx, options.userId);
  const actor: EventActor = { type: 'system', id: 'identity' };
  await writeEvent<Database, UserDeletedData>(
    trx,
    userDeletedEvent(options.userId, { held }, actor),
  );
  await writeEvent<Database, AuditRecordedData>(
    trx,
    auditRecordedEvent(actor, {
      action: `parental.consent.${options.status}`,
      target_type: 'user',
      target_id: options.userId,
    }),
  );
  return true;
}

export async function declineConsent(
  db: Kysely<Database>,
  options: { token: string; now: Date },
): Promise<DeclineConsentResult> {
  return db.transaction().execute(async (trx) => {
    const taken = await takeEmailToken(trx, options.token, 'parental_decline', options.now);
    if (taken.status === 'invalid') return taken;
    const userId = taken.row.user_id;
    if (userId === null) return { status: 'invalid' as const, reason: 'unknown' as const };
    const pending = await findPendingConsent(trx, userId);
    if (pending?.guardian_email_normalized !== taken.row.email_normalized) {
      return { status: 'invalid' as const, reason: 'unknown' as const };
    }
    await useEmailToken(trx, taken.row.id, options.now);
    const deleted = await deleteUnapproved(trx, {
      userId,
      consentId: pending.id,
      status: 'declined',
      now: options.now,
    });
    if (!deleted) return { status: 'invalid' as const, reason: 'unknown' as const };
    return { status: 'ok' as const, userId };
  });
}

export async function expirePendingConsents(
  db: Kysely<Database>,
  options: { pendingTtl: number; now: Date },
): Promise<string[]> {
  const cutoff = new Date(options.now.getTime() - options.pendingTtl);
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('parental_consents')
      .innerJoin('users', 'users.id', 'parental_consents.user_id')
      .select(['parental_consents.id as consent_id', 'parental_consents.user_id as user_id'])
      .where('parental_consents.status', '=', 'pending')
      .where('parental_consents.requested_at', '<=', cutoff)
      .where('users.state', 'in', ['pending_parental_consent', 'pending_email_verification'])
      .execute();
    const expired: string[] = [];
    for (const row of rows) {
      const deleted = await deleteUnapproved(trx, {
        userId: row.user_id,
        consentId: row.consent_id,
        status: 'expired',
        now: options.now,
      });
      if (deleted) expired.push(row.user_id);
    }
    return expired;
  });
}
