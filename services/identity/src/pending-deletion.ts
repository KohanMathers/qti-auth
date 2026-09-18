import { writeEvent } from '@qtiauth/bus';
import type { EventActor } from '@qtiauth/events';
import type { Kysely } from 'kysely';

import { recordAccountAction } from './account-locks.ts';
import type { Database } from './database.ts';
import { type UserUpdatedData, userUpdatedEvent } from './events.ts';

export async function cancelPendingDeletion(
  trx: Kysely<Database>,
  options: { userId: string; now: Date; actor?: EventActor },
): Promise<boolean> {
  const actor = options.actor ?? { type: 'user' as const, id: options.userId };
  const updated = await trx
    .updateTable('users')
    .set({ state: 'active', deletion_requested_at: null, updated_at: options.now })
    .where('id', '=', options.userId)
    .where('state', '=', 'pending_deletion')
    .returning(['id'])
    .executeTakeFirst();
  if (!updated) return false;
  await recordAccountAction(trx, {
    userId: options.userId,
    actor,
    action: 'cancel_deletion',
    reason: 'signed_in',
    fromState: 'pending_deletion',
    toState: 'active',
    expiresAt: null,
    now: options.now,
  });
  await writeEvent<Database, UserUpdatedData>(
    trx,
    userUpdatedEvent(options.userId, { fields: ['state'] }, actor),
  );
  return true;
}
