import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { EventActor } from '@qtiauth/events';
import { type Kysely, sql } from 'kysely';

import { dateOfBirthColumn } from './accounts.ts';
import { type AgeBands, ageOn, dateWhenAgeReached } from './age.ts';
import type { Database, GuardianRemovalStatus } from './database.ts';
import {
  type AuditRecordedData,
  auditRecordedEvent,
  parentalConsentRemovalRequestedEvent,
} from './events.ts';
import { endGuardianLinks, type Guardian, hasActiveGuardians } from './family.ts';

export const GRADUATION_JOB = 'parental.graduation';
export const REMOVAL_REMINDERS_JOB = 'parental.removal_reminders';

export type GuardianRemovalMode = 'blocked' | 'request' | 'self';

export interface GuardianRemovalRequest {
  id: string;
  user_id: string;
  status: GuardianRemovalStatus;
  requested_at: Date;
  decided_at: Date | null;
  last_reminded_at: Date | null;
}

export interface GraduationCandidate {
  user_id: string;
  email: string;
  username: string | null;
  locale: string | null;
}

export type RequestGuardianRemovalResult =
  | { status: 'pending'; id: string; requestedAt: Date }
  | { status: 'removed'; guardians: Guardian[] }
  | { status: 'none' }
  | { status: 'blocked' }
  | { status: 'already_pending' };

export type DecideGuardianRemovalResult =
  { status: 'ok'; guardians?: Guardian[] } | { status: 'not_found' };

function selectRemoval(db: Kysely<Database>) {
  return db
    .selectFrom('guardian_removal_requests')
    .select(['id', 'user_id', 'status', 'requested_at', 'decided_at', 'last_reminded_at']);
}

export function graduationGraceEndsAt(
  dateOfBirth: string,
  consentAge: number,
  graceMs: number,
): Date {
  return new Date(dateWhenAgeReached(dateOfBirth, consentAge).getTime() + graceMs);
}

export function guardianRemovalMode(
  dateOfBirth: string,
  options: { consentAge: number; adultAge: number; graceMs: number; now: Date },
): GuardianRemovalMode {
  const age = ageOn(dateOfBirth, options.now);
  if (age >= options.adultAge) return 'self';
  if (age < options.consentAge) return 'blocked';
  if (options.now < graduationGraceEndsAt(dateOfBirth, options.consentAge, options.graceMs)) {
    return 'blocked';
  }
  return 'request';
}

export function pendingGuardianRemoval(
  db: Kysely<Database>,
  userId: string,
): Promise<GuardianRemovalRequest | undefined> {
  return selectRemoval(db)
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
}

export async function requestGuardianRemoval(
  db: Kysely<Database>,
  options: {
    userId: string;
    dateOfBirth: string;
    bands: AgeBands;
    consentAge: number;
    graceMs: number;
    now: Date;
  },
): Promise<RequestGuardianRemovalResult> {
  if (!(await hasActiveGuardians(db, options.userId))) return { status: 'none' };
  const mode = guardianRemovalMode(options.dateOfBirth, {
    consentAge: options.consentAge,
    adultAge: options.bands.adult,
    graceMs: options.graceMs,
    now: options.now,
  });
  if (mode === 'blocked') return { status: 'blocked' };
  const actor: EventActor = { type: 'user', id: options.userId };
  if (mode === 'self') {
    const ended = await endGuardianLinks(db, {
      childUserId: options.userId,
      actor,
      now: options.now,
    });
    if (ended.status === 'none') return { status: 'none' };
    await db
      .updateTable('guardian_removal_requests')
      .set({ status: 'completed', decided_at: options.now })
      .where('user_id', '=', options.userId)
      .where('status', '=', 'pending')
      .execute();
    return { status: 'removed', guardians: ended.guardians };
  }
  return db.transaction().execute(async (trx) => {
    const existing = await pendingGuardianRemoval(trx, options.userId);
    if (existing) return { status: 'already_pending' as const };
    const id = randomUUIDv7();
    await trx
      .insertInto('guardian_removal_requests')
      .values({
        id,
        user_id: options.userId,
        status: 'pending',
        requested_at: options.now,
        decided_at: null,
        last_reminded_at: options.now,
      })
      .execute();
    await writeEvent<Database, Record<string, never>>(
      trx,
      parentalConsentRemovalRequestedEvent(options.userId, actor),
    );
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditRecordedEvent(actor, {
        action: 'family.removal.requested',
        target_type: 'user',
        target_id: options.userId,
      }),
    );
    return { status: 'pending' as const, id, requestedAt: options.now };
  });
}

export async function cancelGuardianRemoval(
  db: Kysely<Database>,
  options: { userId: string; now: Date },
): Promise<DecideGuardianRemovalResult> {
  const result = await db
    .updateTable('guardian_removal_requests')
    .set({ status: 'cancelled', decided_at: options.now })
    .where('user_id', '=', options.userId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) return { status: 'not_found' };
  return { status: 'ok' };
}

export async function decideGuardianRemoval(
  db: Kysely<Database>,
  options: {
    childUserId: string;
    approve: boolean;
    actor: EventActor;
    now: Date;
  },
): Promise<DecideGuardianRemovalResult> {
  const pending = await pendingGuardianRemoval(db, options.childUserId);
  if (!pending) return { status: 'not_found' };
  if (!options.approve) {
    await db
      .updateTable('guardian_removal_requests')
      .set({ status: 'declined', decided_at: options.now })
      .where('id', '=', pending.id)
      .execute();
    await writeEvent<Database, AuditRecordedData>(
      db,
      auditRecordedEvent(options.actor, {
        action: 'family.removal.declined',
        target_type: 'user',
        target_id: options.childUserId,
      }),
    );
    return { status: 'ok' };
  }
  const ended = await endGuardianLinks(db, {
    childUserId: options.childUserId,
    actor: options.actor,
    now: options.now,
  });
  await db
    .updateTable('guardian_removal_requests')
    .set({ status: 'approved', decided_at: options.now })
    .where('id', '=', pending.id)
    .execute();
  if (ended.status === 'none') return { status: 'ok', guardians: [] };
  return { status: 'ok', guardians: ended.guardians };
}

export async function childrenNeedingGraduationNotice(
  db: Kysely<Database>,
  options: { consentAge: number; now: Date },
): Promise<GraduationCandidate[]> {
  const rows = await db
    .selectFrom('guardians')
    .innerJoin('users', 'users.id', 'guardians.child_user_id')
    .select([
      'users.id as user_id',
      'users.email as email',
      'users.username as username',
      'users.locale as locale',
      dateOfBirthColumn.as('date_of_birth'),
    ])
    .where('guardians.status', '=', 'active')
    .where('users.state', '!=', 'deleted')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('graduation_notices')
            .select(sql`1`.as('ok'))
            .whereRef('graduation_notices.user_id', '=', 'users.id'),
        ),
      ),
    )
    .distinct()
    .orderBy('users.id')
    .execute();
  return rows.flatMap((row) => {
    if (ageOn(row.date_of_birth, options.now) < options.consentAge) return [];
    return [
      {
        user_id: row.user_id,
        email: row.email,
        username: row.username,
        locale: row.locale,
      },
    ];
  });
}

export async function markGraduationNotified(
  db: Kysely<Database>,
  options: { userId: string; consentAge: number; now: Date },
): Promise<boolean> {
  const result = await db
    .insertInto('graduation_notices')
    .values({
      user_id: options.userId,
      notified_at: options.now,
      consent_age: options.consentAge,
    })
    .onConflict((conflict) => conflict.column('user_id').doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

export function pendingRemovalsForReminder(
  db: Kysely<Database>,
  before: Date,
): Promise<
  {
    id: string;
    user_id: string;
    username: string | null;
    locale: string | null;
  }[]
> {
  return db
    .selectFrom('guardian_removal_requests')
    .innerJoin('users', 'users.id', 'guardian_removal_requests.user_id')
    .select([
      'guardian_removal_requests.id as id',
      'users.id as user_id',
      'users.username as username',
      'users.locale as locale',
    ])
    .where('guardian_removal_requests.status', '=', 'pending')
    .where('users.state', '!=', 'deleted')
    .where('guardian_removal_requests.last_reminded_at', '<', before)
    .orderBy('guardian_removal_requests.requested_at')
    .orderBy('guardian_removal_requests.id')
    .execute();
}

export function presentFamilyGraduation(
  account: { date_of_birth: string },
  guardians: Guardian[],
  pending: GuardianRemovalRequest | undefined,
  config: { consentAge: number; graceMs: number },
): {
  guardians: {
    id: string;
    email: string;
    display_name: string | null;
    status: 'pending' | 'active';
    linked: boolean;
  }[];
  pending_removal: { id: string; requested_at: string } | null;
  grace_ends_at: string | null;
} {
  const active = guardians.filter((row) => row.status === 'active');
  return {
    guardians: guardians.map((row) => ({
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      status: row.status === 'pending' ? ('pending' as const) : ('active' as const),
      linked: row.user_id !== null,
    })),
    pending_removal:
      pending === undefined
        ? null
        : { id: pending.id, requested_at: pending.requested_at.toISOString() },
    grace_ends_at:
      active.length === 0
        ? null
        : graduationGraceEndsAt(
            account.date_of_birth,
            config.consentAge,
            config.graceMs,
          ).toISOString(),
  };
}

export async function markRemovalReminded(
  db: Kysely<Database>,
  options: { id: string; now: Date },
): Promise<boolean> {
  const result = await db
    .updateTable('guardian_removal_requests')
    .set({ last_reminded_at: options.now })
    .where('id', '=', options.id)
    .where('status', '=', 'pending')
    .where('last_reminded_at', '<', options.now)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}
