import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import { deletedRows, updatedRows } from '@qtiauth/db';
import type { EventActor } from '@qtiauth/events';
import type { ParentalControls } from '@qtiauth/service-kit';
import { type Kysely, sql } from 'kysely';

import { dateOfBirthColumn } from './accounts.ts';
import { type AgeBands, ageBand, ageOn } from './age.ts';
import type { Database, GuardianStatus, UsernameChangeStatus } from './database.ts';
import {
  insertEmailToken,
  invalidateEmailTokensForAddress,
  takeEmailToken,
  useEmailToken,
} from './email-tokens.ts';
import {
  type AuditRecordedData,
  auditRecordedEvent,
  parentalConsentRevokedEvent,
  type UserUpdatedData,
  userUpdatedEvent,
} from './events.ts';
import type { IdentityConfig } from './service.ts';
import { hashToken, isToken, newToken } from './tokens.ts';
import {
  canonicalUsername,
  claimUsername,
  type ClaimUsernameResult,
  usernameReserved,
  usernameRuleReason,
} from './usernames.ts';

export const ACTIVITY_SUMMARY_JOB = 'parental.activity_summary';
export const FAMILY_TOKEN_PURPOSES = ['family_access', 'family_invite'] as const;
export const DISPLAY_NAME_MAX = 64;
export const CHILD_LABEL = 'your child';

export const DEFAULT_PARENTAL_CONTROLS: ParentalControls = {
  online_play: false,
  in_game_chat: false,
  user_generated_content: false,
  purchases: false,
  daily_playtime_minutes: null,
};

export interface Guardian {
  id: string;
  child_user_id: string;
  email: string;
  email_normalized: string;
  user_id: string | null;
  display_name: string | null;
  status: GuardianStatus;
  invited_by: string | null;
  created_at: Date;
  accepted_at: Date | null;
}

export interface FamilyActor {
  email: string;
  emailNormalized: string;
  locale: string | null;
  userId: string | null;
}

export interface FamilySession {
  id: string;
  token: string;
  email: string;
  emailNormalized: string;
  expiresAt: Date;
}

export interface UsernameChangeRequest {
  id: string;
  user_id: string;
  username: string;
  canonical: string;
  status: UsernameChangeStatus;
  requested_at: Date;
  decided_at: Date | null;
}

export interface FamilyChildSummary {
  id: string;
  username: string | null;
  age_band: ReturnType<typeof ageBand>;
  account_state: string;
}

export interface ChildActivity {
  period_start: string;
  period_end: string;
  sign_ins: number;
  games: [];
  connected_apps: [];
}

export type ActivateGuardianResult = { status: 'ok'; id: string } | { status: 'limit' };

export type InviteGuardianResult =
  | { status: 'ok'; token: string; email: string; locale: string | null; expiresAt: Date }
  | { status: 'invalid' }
  | { status: 'same_as_child' }
  | { status: 'duplicate' }
  | { status: 'limit' }
  | { status: 'blocked' };

export type AcceptInviteResult =
  | { status: 'ok'; childUserId: string }
  | { status: 'invalid' }
  | { status: 'not_adult' }
  | { status: 'limit' };

export type RevokeGuardianResult = { status: 'ok' } | { status: 'not_found' } | { status: 'last' };

export type RequestUsernameChangeResult =
  | { status: 'pending'; id: string; username: string }
  | { status: 'already_pending' }
  | Exclude<ClaimUsernameResult, { status: 'saved' }>;

function selectGuardian(db: Kysely<Database>) {
  return db
    .selectFrom('guardians')
    .select([
      'id',
      'child_user_id',
      'email',
      'email_normalized',
      'user_id',
      'display_name',
      'status',
      'invited_by',
      'created_at',
      'accepted_at',
    ]);
}

export function familyEventActor(actor: FamilyActor): EventActor {
  return actor.userId === null
    ? { type: 'system', id: 'identity' }
    : { type: 'user', id: actor.userId };
}

export function childLabel(username: string | null): string {
  return username === null || username === '' ? CHILD_LABEL : username;
}

export async function hasActiveGuardians(
  db: Kysely<Database>,
  childUserId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('guardians')
    .select('id')
    .where('child_user_id', '=', childUserId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  return row !== undefined;
}

export function listActiveGuardians(
  db: Kysely<Database>,
  childUserId: string,
): Promise<Guardian[]> {
  return selectGuardian(db)
    .where('child_user_id', '=', childUserId)
    .where('status', '=', 'active')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export function listGuardians(db: Kysely<Database>, childUserId: string): Promise<Guardian[]> {
  return selectGuardian(db)
    .where('child_user_id', '=', childUserId)
    .where('status', 'in', ['pending', 'active'])
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

async function countedGuardians(db: Kysely<Database>, childUserId: string): Promise<number> {
  const row = await db
    .selectFrom('guardians')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('child_user_id', '=', childUserId)
    .where('status', 'in', ['pending', 'active'])
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function linkGuardiansToAccount(
  db: Kysely<Database>,
  options: { userId: string; emailNormalized: string; now: Date },
): Promise<void> {
  await db
    .updateTable('guardians')
    .set({ user_id: options.userId, updated_at: options.now })
    .where('email_normalized', '=', options.emailNormalized)
    .where('status', 'in', ['pending', 'active'])
    .where('user_id', 'is', null)
    .execute();
}

export async function ensureParentalControls(
  db: Kysely<Database>,
  userId: string,
  now: Date,
): Promise<void> {
  await db
    .insertInto('parental_controls')
    .values({
      user_id: userId,
      ...DEFAULT_PARENTAL_CONTROLS,
      updated_at: now,
    })
    .onConflict((conflict) => conflict.column('user_id').doNothing())
    .execute();
}

export async function loadParentalControls(
  db: Kysely<Database>,
  userId: string,
): Promise<ParentalControls | null> {
  const row = await db
    .selectFrom('parental_controls')
    .select([
      'online_play',
      'in_game_chat',
      'user_generated_content',
      'purchases',
      'daily_playtime_minutes',
    ])
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    online_play: row.online_play,
    in_game_chat: row.in_game_chat,
    user_generated_content: row.user_generated_content,
    purchases: row.purchases,
    daily_playtime_minutes: row.daily_playtime_minutes,
  };
}

async function findLinkedUser(
  db: Kysely<Database>,
  emailNormalized: string,
): Promise<{ id: string; locale: string | null } | undefined> {
  return db
    .selectFrom('users')
    .select(['id', 'locale'])
    .where('email_normalized', '=', emailNormalized)
    .where('state', '!=', 'deleted')
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();
}

export async function activateApprovingGuardian(
  db: Kysely<Database>,
  options: {
    childUserId: string;
    email: string;
    emailNormalized: string;
    maxGuardians: number;
    now: Date;
  },
): Promise<ActivateGuardianResult> {
  const existing = await db
    .selectFrom('guardians')
    .select(['id', 'status'])
    .where('child_user_id', '=', options.childUserId)
    .where('email_normalized', '=', options.emailNormalized)
    .where('status', 'in', ['pending', 'active'])
    .executeTakeFirst();
  if (existing?.status === 'active') {
    await ensureParentalControls(db, options.childUserId, options.now);
    return { status: 'ok', id: existing.id };
  }
  if ((await countedGuardians(db, options.childUserId)) >= options.maxGuardians && !existing) {
    return { status: 'limit' };
  }
  const linked = await findLinkedUser(db, options.emailNormalized);
  const id = existing?.id ?? randomUUIDv7();
  if (existing) {
    await db
      .updateTable('guardians')
      .set({
        email: options.email,
        status: 'active',
        user_id: linked?.id ?? null,
        accepted_at: options.now,
        updated_at: options.now,
      })
      .where('id', '=', existing.id)
      .execute();
  } else {
    await db
      .insertInto('guardians')
      .values({
        id,
        child_user_id: options.childUserId,
        email: options.email,
        email_normalized: options.emailNormalized,
        user_id: linked?.id ?? null,
        display_name: null,
        status: 'active',
        invited_by: null,
        created_at: options.now,
        updated_at: options.now,
        accepted_at: options.now,
        revoked_at: null,
      })
      .execute();
  }
  await ensureParentalControls(db, options.childUserId, options.now);
  return { status: 'ok', id };
}

export async function inviteGuardian(
  db: Kysely<Database>,
  options: {
    childUserId: string;
    childNormalized: string;
    email: string;
    displayName: string | null;
    invitedBy: string | null;
    actor: EventActor;
    locale: string | null;
    settings: { maxGuardians: number; normalizeEmail: (address: string) => string };
    isBlocked: (name: string) => Promise<boolean>;
    ttl: number;
    now: Date;
  },
): Promise<InviteGuardianResult> {
  const email = options.email.trim();
  if (email === '' || !email.includes('@')) return { status: 'invalid' };
  const emailNormalized = options.settings.normalizeEmail(email);
  if (emailNormalized === options.childNormalized) return { status: 'same_as_child' };
  const trimmedName = options.displayName?.trim() ?? '';
  const displayName = trimmedName === '' ? null : trimmedName;
  if (displayName !== null) {
    if (displayName.length > DISPLAY_NAME_MAX) return { status: 'blocked' };
    if (await options.isBlocked(displayName)) return { status: 'blocked' };
  }
  return db.transaction().execute(async (trx) => {
    const duplicate = await trx
      .selectFrom('guardians')
      .select('id')
      .where('child_user_id', '=', options.childUserId)
      .where('email_normalized', '=', emailNormalized)
      .where('status', 'in', ['pending', 'active'])
      .executeTakeFirst();
    if (duplicate) return { status: 'duplicate' as const };
    if ((await countedGuardians(trx, options.childUserId)) >= options.settings.maxGuardians) {
      return { status: 'limit' as const };
    }
    const linked = await findLinkedUser(trx, emailNormalized);
    const id = randomUUIDv7();
    await trx
      .insertInto('guardians')
      .values({
        id,
        child_user_id: options.childUserId,
        email,
        email_normalized: emailNormalized,
        user_id: linked?.id ?? null,
        display_name: displayName,
        status: 'pending',
        invited_by: options.invitedBy,
        created_at: options.now,
        updated_at: options.now,
        accepted_at: null,
        revoked_at: null,
      })
      .execute();
    await invalidateEmailTokensForAddress(trx, {
      emailNormalized,
      purposes: ['family_invite'],
      now: options.now,
    });
    const expiresAt = new Date(options.now.getTime() + options.ttl);
    const token = await insertEmailToken(trx, {
      purpose: 'family_invite',
      email,
      emailNormalized,
      locale: options.locale ?? linked?.locale ?? null,
      returnTo: null,
      userId: options.childUserId,
      expiresAt,
      now: options.now,
    });
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(options.actor, {
        action: 'family.guardian.invited',
        target_type: 'user',
        target_id: options.childUserId,
      }),
    );
    return {
      status: 'ok' as const,
      token,
      email,
      locale: options.locale ?? linked?.locale ?? null,
      expiresAt,
    };
  });
}

export async function acceptGuardianInvite(
  db: Kysely<Database>,
  options: {
    token: string;
    dateOfBirth: string;
    bands: AgeBands;
    maxGuardians: number;
    now: Date;
  },
): Promise<AcceptInviteResult> {
  const age = ageOn(options.dateOfBirth, options.now);
  if (age < options.bands.adult) return { status: 'not_adult' };
  return db.transaction().execute(async (trx) => {
    const taken = await takeEmailToken(trx, options.token, 'family_invite', options.now);
    if (taken.status === 'invalid') return { status: 'invalid' as const };
    const childUserId = taken.row.user_id;
    if (childUserId === null) return { status: 'invalid' as const };
    const pending = await trx
      .selectFrom('guardians')
      .select(['id', 'email_normalized'])
      .where('child_user_id', '=', childUserId)
      .where('email_normalized', '=', taken.row.email_normalized)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (!pending) return { status: 'invalid' as const };
    const active = await trx
      .selectFrom('guardians')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('child_user_id', '=', childUserId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (Number(active?.count ?? 0) >= options.maxGuardians) return { status: 'limit' as const };
    await useEmailToken(trx, taken.row.id, options.now);
    const linked = await findLinkedUser(trx, pending.email_normalized);
    await trx
      .updateTable('guardians')
      .set({
        status: 'active',
        user_id: linked?.id ?? null,
        accepted_at: options.now,
        updated_at: options.now,
      })
      .where('id', '=', pending.id)
      .where('status', '=', 'pending')
      .execute();
    await ensureParentalControls(trx, childUserId, options.now);
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(
        linked === undefined ? { type: 'system', id: 'identity' } : { type: 'user', id: linked.id },
        { action: 'family.guardian.accepted', target_type: 'user', target_id: childUserId },
      ),
    );
    return { status: 'ok' as const, childUserId };
  });
}

export async function revokeGuardian(
  db: Kysely<Database>,
  options: {
    childUserId: string;
    guardianId: string;
    actor: EventActor;
    now: Date;
  },
): Promise<RevokeGuardianResult> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('guardians')
      .select(['id', 'status'])
      .where('id', '=', options.guardianId)
      .where('child_user_id', '=', options.childUserId)
      .where('status', 'in', ['pending', 'active'])
      .executeTakeFirst();
    if (!row) return { status: 'not_found' as const };
    if (row.status === 'active') {
      const others = await trx
        .selectFrom('guardians')
        .select('id')
        .where('child_user_id', '=', options.childUserId)
        .where('status', '=', 'active')
        .where('id', '!=', row.id)
        .executeTakeFirst();
      if (!others) return { status: 'last' as const };
    }
    await trx
      .updateTable('guardians')
      .set({
        status: 'revoked',
        revoked_at: options.now,
        updated_at: options.now,
      })
      .where('id', '=', row.id)
      .execute();
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(options.actor, {
        action: 'family.guardian.revoked',
        target_type: 'user',
        target_id: options.childUserId,
      }),
    );
    return { status: 'ok' as const };
  });
}

export async function endGuardianLinks(
  db: Kysely<Database>,
  options: {
    childUserId: string;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; guardians: Guardian[] } | { status: 'none' }> {
  return db.transaction().execute(async (trx) => {
    const guardians = await selectGuardian(trx)
      .where('child_user_id', '=', options.childUserId)
      .where('status', 'in', ['pending', 'active'])
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    if (guardians.length === 0) return { status: 'none' as const };
    await trx
      .updateTable('guardians')
      .set({
        status: 'revoked',
        revoked_at: options.now,
        updated_at: options.now,
      })
      .where('child_user_id', '=', options.childUserId)
      .where('status', 'in', ['pending', 'active'])
      .execute();
    await trx.deleteFrom('parental_controls').where('user_id', '=', options.childUserId).execute();
    await trx
      .updateTable('username_change_requests')
      .set({ status: 'cancelled', decided_at: options.now })
      .where('user_id', '=', options.childUserId)
      .where('status', '=', 'pending')
      .execute();
    await writeEvent<Database, Record<string, never>>(
      trx,
      parentalConsentRevokedEvent(options.childUserId, options.actor),
    );
    await writeEvent<Database, UserUpdatedData>(
      trx,
      userUpdatedEvent(options.childUserId, { fields: ['parental_controls'] }, options.actor),
    );
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(options.actor, {
        action: 'family.removal.completed',
        target_type: 'user',
        target_id: options.childUserId,
      }),
    );
    return { status: 'ok' as const, guardians };
  });
}

export async function issueFamilyAccess(
  db: Kysely<Database>,
  options: {
    email: string;
    normalizeEmail: (address: string) => string;
    ttl: number;
    now: Date;
  },
): Promise<{ token: string; email: string; locale: string | null; expiresAt: Date } | undefined> {
  const email = options.email.trim();
  if (!email.includes('@')) return undefined;
  const emailNormalized = options.normalizeEmail(email);
  const guardian = await db
    .selectFrom('guardians')
    .select(['email', 'email_normalized', 'user_id'])
    .where('email_normalized', '=', emailNormalized)
    .where('status', '=', 'active')
    .orderBy('created_at')
    .executeTakeFirst();
  if (!guardian) return undefined;
  const linked = guardian.user_id
    ? await db
        .selectFrom('users')
        .select('locale')
        .where('id', '=', guardian.user_id)
        .executeTakeFirst()
    : undefined;
  const expiresAt = new Date(options.now.getTime() + options.ttl);
  await invalidateEmailTokensForAddress(db, {
    emailNormalized,
    purposes: ['family_access'],
    now: options.now,
  });
  const token = await insertEmailToken(db, {
    purpose: 'family_access',
    email: guardian.email,
    emailNormalized,
    locale: linked?.locale ?? null,
    returnTo: null,
    userId: null,
    expiresAt,
    now: options.now,
  });
  return { token, email: guardian.email, locale: linked?.locale ?? null, expiresAt };
}

export async function createFamilySession(
  db: Kysely<Database>,
  options: { token: string; sessionTtl: number; now: Date },
): Promise<FamilySession | undefined> {
  return db.transaction().execute(async (trx) => {
    const taken = await takeEmailToken(trx, options.token, 'family_access', options.now);
    if (taken.status === 'invalid') return undefined;
    const guardian = await trx
      .selectFrom('guardians')
      .select(['email', 'email_normalized'])
      .where('email_normalized', '=', taken.row.email_normalized)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!guardian) return undefined;
    await useEmailToken(trx, taken.row.id, options.now);
    await trx
      .updateTable('family_sessions')
      .set({ revoked_at: options.now })
      .where('email_normalized', '=', guardian.email_normalized)
      .where('revoked_at', 'is', null)
      .execute();
    const id = randomUUIDv7();
    const value = newToken();
    const expiresAt = new Date(options.now.getTime() + options.sessionTtl);
    await trx
      .insertInto('family_sessions')
      .values({
        id,
        token_hash: hashToken(value),
        email: guardian.email,
        email_normalized: guardian.email_normalized,
        created_at: options.now,
        last_active_at: options.now,
        expires_at: expiresAt,
        revoked_at: null,
      })
      .execute();
    return {
      id,
      token: value,
      email: guardian.email,
      emailNormalized: guardian.email_normalized,
      expiresAt,
    };
  });
}

export async function loadFamilySession(
  db: Kysely<Database>,
  options: { token: string; idleTimeout: number; now: Date },
): Promise<FamilyActor | undefined> {
  if (!isToken(options.token)) return undefined;
  const row = await db
    .selectFrom('family_sessions')
    .select(['id', 'email', 'email_normalized', 'last_active_at', 'expires_at', 'revoked_at'])
    .where('token_hash', '=', hashToken(options.token))
    .executeTakeFirst();
  if (row?.revoked_at !== null) return undefined;
  if (row.expires_at <= options.now) return undefined;
  if (options.now.getTime() - row.last_active_at.getTime() >= options.idleTimeout) return undefined;
  await db
    .updateTable('family_sessions')
    .set({ last_active_at: options.now })
    .where('id', '=', row.id)
    .where('last_active_at', '<', options.now)
    .execute();
  const linked = await findLinkedUser(db, row.email_normalized);
  return {
    email: row.email,
    emailNormalized: row.email_normalized,
    locale: linked?.locale ?? null,
    userId: linked?.id ?? null,
  };
}

export async function revokeFamilySession(
  db: Kysely<Database>,
  options: { token: string; now: Date },
): Promise<boolean> {
  if (!isToken(options.token)) return false;
  const result = await db
    .updateTable('family_sessions')
    .set({ revoked_at: options.now })
    .where('token_hash', '=', hashToken(options.token))
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return updatedRows(result) > 0;
}

export async function sweepFamilySessions(
  db: Kysely<Database>,
  options: { retention: number; idleTimeout: number; now: Date },
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.retention);
  const idle = new Date(options.now.getTime() - options.idleTimeout);
  const result = await db
    .deleteFrom('family_sessions')
    .where((eb) =>
      eb.or([
        eb('revoked_at', '<', cutoff),
        eb('expires_at', '<', cutoff),
        eb.and([eb('revoked_at', 'is', null), eb('last_active_at', '<', idle)]),
      ]),
    )
    .execute();
  return deletedRows(result);
}

export async function actorFromSession(
  db: Kysely<Database>,
  sessionId: string,
): Promise<FamilyActor | undefined> {
  const row = await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'users.id as user_id',
      'users.email as email',
      'users.email_normalized as email_normalized',
      'users.locale as locale',
    ])
    .where('sessions.id', '=', sessionId)
    .where('sessions.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row) return undefined;
  const guardian = await db
    .selectFrom('guardians')
    .select('id')
    .where((eb) =>
      eb.or([eb('user_id', '=', row.user_id), eb('email_normalized', '=', row.email_normalized)]),
    )
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!guardian) return undefined;
  return {
    email: row.email,
    emailNormalized: row.email_normalized,
    locale: row.locale,
    userId: row.user_id,
  };
}

export async function resolveFamilyActor(
  db: Kysely<Database>,
  options: {
    familyToken: string | null;
    sessionId: string | null;
    idleTimeout: number;
    now: Date;
  },
): Promise<FamilyActor | undefined> {
  if (options.familyToken !== null) {
    const fromToken = await loadFamilySession(db, {
      token: options.familyToken,
      idleTimeout: options.idleTimeout,
      now: options.now,
    });
    if (fromToken) return fromToken;
  }
  if (options.sessionId !== null) return actorFromSession(db, options.sessionId);
  return undefined;
}

export async function actorManagesChild(
  db: Kysely<Database>,
  actor: FamilyActor,
  childUserId: string,
): Promise<Guardian | undefined> {
  return selectGuardian(db)
    .where('child_user_id', '=', childUserId)
    .where('status', '=', 'active')
    .where((eb) =>
      actor.userId === null
        ? eb('email_normalized', '=', actor.emailNormalized)
        : eb.or([
            eb('email_normalized', '=', actor.emailNormalized),
            eb('user_id', '=', actor.userId),
          ]),
    )
    .executeTakeFirst();
}

export async function listFamilyChildren(
  db: Kysely<Database>,
  actor: FamilyActor,
  bands: AgeBands,
  now: Date,
): Promise<FamilyChildSummary[]> {
  let query = db
    .selectFrom('guardians')
    .innerJoin('users', 'users.id', 'guardians.child_user_id')
    .select([
      'users.id as id',
      'users.username as username',
      'users.state as account_state',
      dateOfBirthColumn.as('date_of_birth'),
    ])
    .where('guardians.status', '=', 'active')
    .where('users.state', '!=', 'deleted');
  query =
    actor.userId === null
      ? query.where('guardians.email_normalized', '=', actor.emailNormalized)
      : query.where((eb) =>
          eb.or([
            eb('guardians.email_normalized', '=', actor.emailNormalized),
            eb('guardians.user_id', '=', actor.userId),
          ]),
        );
  const rows = await query.orderBy('users.created_at').orderBy('users.id').execute();
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    age_band: ageBand(ageOn(row.date_of_birth, now), bands),
    account_state: row.account_state,
  }));
}

export async function updateChildControls(
  db: Kysely<Database>,
  options: {
    childUserId: string;
    actor: EventActor;
    controls: {
      online_play?: boolean | undefined;
      in_game_chat?: boolean | undefined;
      user_generated_content?: boolean | undefined;
      purchases?: boolean | undefined;
      daily_playtime_minutes?: number | null | undefined;
      public_profile?: boolean | undefined;
      leaderboard_visible?: boolean | undefined;
    };
    now: Date;
  },
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await ensureParentalControls(trx, options.childUserId, options.now);
    const parental: {
      online_play?: boolean;
      in_game_chat?: boolean;
      user_generated_content?: boolean;
      purchases?: boolean;
      daily_playtime_minutes?: number | null;
      updated_at: Date;
    } = { updated_at: options.now };
    if (options.controls.online_play !== undefined)
      parental.online_play = options.controls.online_play;
    if (options.controls.in_game_chat !== undefined)
      parental.in_game_chat = options.controls.in_game_chat;
    if (options.controls.user_generated_content !== undefined) {
      parental.user_generated_content = options.controls.user_generated_content;
    }
    if (options.controls.purchases !== undefined) parental.purchases = options.controls.purchases;
    if (options.controls.daily_playtime_minutes !== undefined) {
      parental.daily_playtime_minutes = options.controls.daily_playtime_minutes;
    }
    const parentalChanged = Object.keys(parental).length > 1;
    if (parentalChanged) {
      await trx
        .updateTable('parental_controls')
        .set(parental)
        .where('user_id', '=', options.childUserId)
        .execute();
    }
    const profile: {
      public_profile?: boolean;
      leaderboard_visible?: boolean;
      updated_at: Date;
    } = { updated_at: options.now };
    if (options.controls.public_profile !== undefined)
      profile.public_profile = options.controls.public_profile;
    if (options.controls.leaderboard_visible !== undefined) {
      profile.leaderboard_visible = options.controls.leaderboard_visible;
    }
    const profileChanged = Object.keys(profile).length > 1;
    if (profileChanged) {
      await trx.updateTable('users').set(profile).where('id', '=', options.childUserId).execute();
    }
    if (!parentalChanged && !profileChanged) return true;
    await writeEvent<Database, UserUpdatedData>(
      trx,
      userUpdatedEvent(options.childUserId, { fields: ['parental_controls'] }, options.actor),
    );
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(options.actor, {
        action: 'family.controls.updated',
        target_type: 'user',
        target_id: options.childUserId,
      }),
    );
    return true;
  });
}

export async function pendingUsernameChange(
  db: Kysely<Database>,
  userId: string,
): Promise<UsernameChangeRequest | undefined> {
  return db
    .selectFrom('username_change_requests')
    .select(['id', 'user_id', 'username', 'canonical', 'status', 'requested_at', 'decided_at'])
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
}

export async function requestUsernameChange(
  db: Kysely<Database>,
  options: {
    userId: string;
    username: string;
    settings: IdentityConfig['usernames'];
    isBlocked: (username: string) => Promise<boolean>;
    now: Date;
  },
): Promise<RequestUsernameChangeResult> {
  const invalid = usernameRuleReason(options.username, options.settings);
  if (invalid !== undefined) return { status: 'invalid', reason: invalid };
  const canonical = canonicalUsername(options.username);
  if (usernameReserved(canonical, options.settings)) return { status: 'unavailable' };
  if (await options.isBlocked(options.username)) return { status: 'unavailable' };
  const account = await db
    .selectFrom('users')
    .select(['id', 'state', 'username'])
    .where('id', '=', options.userId)
    .executeTakeFirst();
  if (!account || account.state === 'deleted') return { status: 'not_found' };
  if (account.username !== null && canonicalUsername(account.username) === canonical) {
    return { status: 'unchanged' };
  }
  return db.transaction().execute(async (trx) => {
    const existing = await pendingUsernameChange(trx, options.userId);
    if (existing) return { status: 'already_pending' as const };
    const holder = await trx
      .selectFrom('users')
      .select('id')
      .where('username_canonical', '=', canonical)
      .executeTakeFirst();
    if (holder !== undefined && holder.id !== options.userId)
      return { status: 'unavailable' as const };
    const id = randomUUIDv7();
    await trx
      .insertInto('username_change_requests')
      .values({
        id,
        user_id: options.userId,
        username: options.username,
        canonical,
        status: 'pending',
        requested_at: options.now,
        decided_at: null,
      })
      .execute();
    return { status: 'pending' as const, id, username: options.username };
  });
}

export async function decideUsernameChange(
  db: Kysely<Database>,
  options: {
    childUserId: string;
    requestId: string;
    approve: boolean;
    settings: IdentityConfig['usernames'];
    isBlocked: (username: string) => Promise<boolean>;
    actor: EventActor;
    now: Date;
  },
): Promise<
  | { status: 'ok'; username?: string }
  | { status: 'not_found' }
  | { status: 'unavailable' }
  | { status: 'cooldown'; availableAt: Date }
  | { status: 'limit' }
> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('username_change_requests')
      .select(['id', 'username', 'status'])
      .where('id', '=', options.requestId)
      .where('user_id', '=', options.childUserId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (!row) return { status: 'not_found' as const };
    if (!options.approve) {
      await trx
        .updateTable('username_change_requests')
        .set({ status: 'declined', decided_at: options.now })
        .where('id', '=', row.id)
        .execute();
      await writeEvent<Database, AuditRecordedData>(
        trx,
        auditRecordedEvent(options.actor, {
          action: 'family.username.declined',
          target_type: 'user',
          target_id: options.childUserId,
        }),
      );
      return { status: 'ok' as const };
    }
    const claimed = await claimUsername(trx, {
      userId: options.childUserId,
      username: row.username,
      settings: options.settings,
      isBlocked: options.isBlocked,
      now: options.now,
    });
    if (claimed.status !== 'saved') {
      if (
        claimed.status === 'unavailable' ||
        claimed.status === 'cooldown' ||
        claimed.status === 'limit'
      ) {
        return claimed;
      }
      return { status: 'unavailable' as const };
    }
    await trx
      .updateTable('username_change_requests')
      .set({ status: 'approved', decided_at: options.now })
      .where('id', '=', row.id)
      .execute();
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(options.actor, {
        action: 'family.username.approved',
        target_type: 'user',
        target_id: options.childUserId,
      }),
    );
    return { status: 'ok' as const, username: claimed.username };
  });
}

export async function childActivity(
  db: Kysely<Database>,
  options: { childUserId: string; now: Date; windowMs?: number },
): Promise<ChildActivity> {
  const windowMs = options.windowMs ?? 7 * 86_400_000;
  const periodStart = new Date(options.now.getTime() - windowMs);
  const row = await db
    .selectFrom('sessions')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('user_id', '=', options.childUserId)
    .where('created_at', '>=', periodStart)
    .executeTakeFirst();
  return {
    period_start: periodStart.toISOString(),
    period_end: options.now.toISOString(),
    sign_ins: Number(row?.count ?? 0),
    games: [],
    connected_apps: [],
  };
}

export async function childrenNeedingActivitySummary(
  db: Kysely<Database>,
  periodStart: string,
): Promise<{ child_user_id: string; username: string | null; locale: string | null }[]> {
  return db
    .selectFrom('guardians')
    .innerJoin('users', 'users.id', 'guardians.child_user_id')
    .select(['users.id as child_user_id', 'users.username as username', 'users.locale as locale'])
    .where('guardians.status', '=', 'active')
    .where('users.state', '!=', 'deleted')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('family_activity_notices')
            .select(sql`1`.as('ok'))
            .whereRef('family_activity_notices.child_user_id', '=', 'users.id')
            .where(sql<boolean>`family_activity_notices.period_start = ${periodStart}::date`),
        ),
      ),
    )
    .distinct()
    .orderBy('users.id')
    .execute();
}

export async function markActivitySummarySent(
  db: Kysely<Database>,
  options: { childUserId: string; periodStart: string; now: Date },
): Promise<boolean> {
  const result = await db
    .insertInto('family_activity_notices')
    .values({
      child_user_id: options.childUserId,
      period_start: options.periodStart,
      sent_at: options.now,
    })
    .onConflict((conflict) => conflict.columns(['child_user_id', 'period_start']).doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

export function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
