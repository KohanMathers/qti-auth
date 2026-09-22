import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import { deletedRows } from '@qtiauth/db';
import type { EventActor } from '@qtiauth/events';
import type { Kysely } from 'kysely';

import type { Database } from './database.ts';
import { type UserRestrictedData, userRestrictedEvent } from './events.ts';

export const USERNAME_CHANGE_RESTRICTION = 'username_change';
export const RESTRICTION_EXPIRED_REASON = 'expired';

export function activeRestrictionNames(
  rows: readonly { name: string; expires_at: Date | null }[],
  now: Date,
): string[] {
  return rows
    .filter((row) => row.expires_at === null || row.expires_at.getTime() > now.getTime())
    .map((row) => row.name)
    .sort();
}

export async function loadActiveRestrictions(
  db: Kysely<Database>,
  userId: string,
  now: Date,
): Promise<string[]> {
  const rows = await db
    .selectFrom('user_restrictions')
    .select(['name', 'expires_at'])
    .where('user_id', '=', userId)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
    .orderBy('name')
    .execute();
  return rows.map((row) => row.name);
}

async function emitRestrictions(
  trx: Kysely<Database>,
  userId: string,
  actor: EventActor,
  now: Date,
  reason?: string,
): Promise<string[]> {
  const restrictions = await loadActiveRestrictions(trx, userId, now);
  await writeEvent<Database, UserRestrictedData>(
    trx,
    userRestrictedEvent(
      userId,
      {
        restrictions,
        ...(reason === undefined ? {} : { reason }),
      },
      actor,
    ),
  );
  return restrictions;
}

export async function expireRestrictions(
  db: Kysely<Database>,
  now: Date,
  userId?: string,
): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    let query = trx
      .deleteFrom('user_restrictions')
      .where('expires_at', 'is not', null)
      .where('expires_at', '<=', now);
    if (userId !== undefined) query = query.where('user_id', '=', userId);
    const rows = await query.returning('user_id').execute();
    const ids = [...new Set(rows.map((row) => row.user_id))];
    const actor: EventActor = { type: 'system', id: 'identity' };
    for (const id of ids) {
      await emitRestrictions(trx, id, actor, now, RESTRICTION_EXPIRED_REASON);
    }
    return ids;
  });
}

export async function setRestrictions(
  trx: Kysely<Database>,
  options: {
    userId: string;
    names: readonly string[];
    actionId: string;
    expiresAt: Date | null;
    actor: EventActor;
    reason: string;
    now: Date;
  },
): Promise<string[]> {
  if (options.names.length === 0) return loadActiveRestrictions(trx, options.userId, options.now);
  for (const name of options.names) {
    await trx
      .insertInto('user_restrictions')
      .values({
        id: randomUUIDv7(),
        user_id: options.userId,
        name,
        action_id: options.actionId,
        expires_at: options.expiresAt,
        created_at: options.now,
      })
      .onConflict((conflict) =>
        conflict.columns(['user_id', 'name']).doUpdateSet({
          action_id: options.actionId,
          expires_at: options.expiresAt,
        }),
      )
      .execute();
  }
  return emitRestrictions(trx, options.userId, options.actor, options.now, options.reason);
}

export async function clearRestrictions(
  trx: Kysely<Database>,
  options: {
    userId: string;
    actionId: string;
    actor: EventActor;
    reason: string;
    now: Date;
  },
): Promise<string[]> {
  const deleted = await trx
    .deleteFrom('user_restrictions')
    .where('user_id', '=', options.userId)
    .where('action_id', '=', options.actionId)
    .executeTakeFirst();
  if (deletedRows(deleted) === 0) {
    return loadActiveRestrictions(trx, options.userId, options.now);
  }
  return emitRestrictions(trx, options.userId, options.actor, options.now, options.reason);
}
