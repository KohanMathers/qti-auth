import { writeEvent } from '@qtiauth/bus';
import type { EventActor } from '@qtiauth/events';
import type { AccountState } from '@qtiauth/service-kit';
import { type Kysely, sql } from 'kysely';

import { recordAccountAction } from './account-locks.ts';
import type { Database } from './database.ts';
import { type UserUpdatedData, userUpdatedEvent } from './events.ts';

export async function cancelPendingDeletion(
  trx: Kysely<Database>,
  options: { userId: string; now: Date; actor?: EventActor },
): Promise<boolean> {
  const actor: EventActor = options.actor ?? { type: 'user', id: options.userId };
  // Go back to the state the deletion was requested from, so a ban or lock survives.
  const updated = await trx
    .updateTable('users')
    .set({
      state: sql<AccountState>`coalesce(pre_deletion_state, 'active')`,
      pre_deletion_state: null,
      deletion_requested_at: null,
      updated_at: options.now,
    })
    .where('id', '=', options.userId)
    .where('state', '=', 'pending_deletion')
    .returning(['state'])
    .executeTakeFirst();
  if (!updated) return false;
  await recordAccountAction(trx, {
    userId: options.userId,
    actor,
    action: 'cancel_deletion',
    reason: 'signed_in',
    fromState: 'pending_deletion',
    toState: updated.state,
    expiresAt: null,
    now: options.now,
  });
  await writeEvent<Database, UserUpdatedData>(
    trx,
    userUpdatedEvent(options.userId, { fields: ['state'] }, actor),
  );
  return true;
}
