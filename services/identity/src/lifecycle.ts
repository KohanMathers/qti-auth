import { writeEvent } from '@qtiauth/bus';
import type { EventActor } from '@qtiauth/events';
import { type Kysely } from 'kysely';

import { recordAccountAction } from './account-locks.ts';
import { assertTransition } from './accounts.ts';
import type { Database } from './database.ts';
import {
  type UserDeletedData,
  type UserUpdatedData,
  userDeletedEvent,
  userUpdatedEvent,
} from './events.ts';
import { hasActiveHold } from './legal-holds.ts';
import { revokeSessions } from './sessions.ts';

export const PURGE_JOB = 'accounts.purge_deleted';

export type RequestDeletionStatus = 'ok' | 'not_found' | 'conflict';

export async function requestDeletion(
  db: Kysely<Database>,
  options: { userId: string; actor: EventActor; now: Date },
): Promise<{ status: RequestDeletionStatus; revoked: string[] }> {
  return db.transaction().execute(async (trx) => {
    const account = await trx
      .selectFrom('users')
      .select(['id', 'state'])
      .where('id', '=', options.userId)
      .executeTakeFirst();
    if (!account) return { status: 'not_found' as const, revoked: [] };
    if (account.state === 'pending_deletion') return { status: 'ok' as const, revoked: [] };
    if (account.state === 'deleted') return { status: 'conflict' as const, revoked: [] };
    try {
      assertTransition(account.state, 'pending_deletion');
    } catch {
      return { status: 'conflict' as const, revoked: [] };
    }
    const updated = await trx
      .updateTable('users')
      .set({
        state: 'pending_deletion',
        deletion_requested_at: options.now,
        locked_until: null,
        updated_at: options.now,
      })
      .where('id', '=', options.userId)
      .where('state', '=', account.state)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) return { status: 'conflict' as const, revoked: [] };
    await recordAccountAction(trx, {
      userId: options.userId,
      actor: options.actor,
      action: 'request_deletion',
      reason: 'user_requested',
      fromState: account.state,
      toState: 'pending_deletion',
      expiresAt: null,
      now: options.now,
    });
    await writeEvent<Database, UserUpdatedData>(
      trx,
      userUpdatedEvent(options.userId, { fields: ['state'] }, options.actor),
    );
    const revoked = await revokeSessions(trx, {
      userId: options.userId,
      reason: 'revoked',
      now: options.now,
    });
    return { status: 'ok' as const, revoked };
  });
}

export async function purgeExpiredDeletions(
  db: Kysely<Database>,
  options: { grace: number; now: Date },
): Promise<string[]> {
  const cutoff = new Date(options.now.getTime() - options.grace);
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom('users')
      .select('id')
      .where('state', '=', 'pending_deletion')
      .where('deletion_requested_at', 'is not', null)
      .where('deletion_requested_at', '<=', cutoff)
      .execute();
    const actor: EventActor = { type: 'system', id: 'identity' };
    const deleted: string[] = [];
    for (const row of rows) {
      const held = await hasActiveHold(trx, row.id);
      const moved = await trx
        .updateTable('users')
        .set({ state: 'deleted', updated_at: options.now })
        .where('id', '=', row.id)
        .where('state', '=', 'pending_deletion')
        .executeTakeFirst();
      if (moved.numUpdatedRows === 0n) continue;
      await writeEvent<Database, UserDeletedData>(trx, userDeletedEvent(row.id, { held }, actor));
      deleted.push(row.id);
    }
    return deleted;
  });
}
