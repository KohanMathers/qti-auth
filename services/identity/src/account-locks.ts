import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { EventActor } from '@qtiauth/events';
import type { AccountState } from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import type { AccountAction, Database } from './database.ts';
import {
  type AuditRecordedData,
  auditRecordedEvent,
  type UserUnlockedData,
  userUnlockedEvent,
} from './events.ts';

export const UNLOCK_JOB = 'accounts.unlock_expired';
export const LOCK_EXPIRED_REASON = 'expired';

export async function recordAccountAction(
  trx: Kysely<Database>,
  options: {
    userId: string;
    actor: EventActor;
    action: AccountAction;
    reason: string;
    fromState: AccountState | null;
    toState: AccountState | null;
    expiresAt: Date | null;
    now: Date;
  },
): Promise<void> {
  await trx
    .insertInto('account_actions')
    .values({
      id: randomUUIDv7(),
      user_id: options.userId,
      actor_type: options.actor.type,
      actor_id: options.actor.id,
      action: options.action,
      reason: options.reason,
      from_state: options.fromState,
      to_state: options.toState,
      expires_at: options.expiresAt,
      created_at: options.now,
    })
    .execute();
  await writeEvent<Database, AuditRecordedData>(
    trx,
    auditRecordedEvent(options.actor, {
      action: `user.${options.action}`,
      target_type: 'user',
      target_id: options.userId,
    }),
  );
}

export async function expireLocks(
  db: Kysely<Database>,
  now: Date,
  userId?: string,
): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    let query = trx
      .updateTable('users')
      .set({ state: 'active', locked_until: null, updated_at: now })
      .where('state', '=', 'locked')
      .where('locked_until', 'is not', null)
      .where('locked_until', '<=', now);
    if (userId !== undefined) query = query.where('id', '=', userId);
    const rows = await query.returning('id').execute();
    const actor: EventActor = { type: 'system', id: 'identity' };
    for (const row of rows) {
      await recordAccountAction(trx, {
        userId: row.id,
        actor,
        action: 'unlock',
        reason: LOCK_EXPIRED_REASON,
        fromState: 'locked',
        toState: 'active',
        expiresAt: null,
        now,
      });
      await writeEvent<Database, UserUnlockedData>(
        trx,
        userUnlockedEvent(row.id, { reason: LOCK_EXPIRED_REASON }, actor),
      );
    }
    return rows.map((row) => row.id);
  });
}
