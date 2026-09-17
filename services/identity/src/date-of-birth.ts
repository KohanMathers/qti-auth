import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { AgeBand } from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import { findAccount } from './accounts.ts';
import {
  type AgeBands,
  ageOn,
  agePrivacyDefaults,
  bandOn,
  isValidDateOfBirth,
  under18,
} from './age.ts';
import type { Database } from './database.ts';
import {
  type UserAgeBandChangedData,
  type UserUpdatedData,
  userAgeBandChangedEvent,
  userUpdatedEvent,
} from './events.ts';

export type EditDateOfBirthResult =
  | { status: 'not_found' }
  | { status: 'invalid' }
  | { status: 'unchanged' }
  | { status: 'updated'; dateOfBirth: string; ageBand: AgeBand; previousAgeBand: AgeBand };

export async function editDateOfBirth(
  db: Kysely<Database>,
  options: {
    userId: string;
    actorId: string;
    dateOfBirth: string;
    reason: string;
    bands: AgeBands;
    now: Date;
  },
): Promise<EditDateOfBirthResult> {
  if (!isValidDateOfBirth(options.dateOfBirth, options.now)) return { status: 'invalid' };

  return db.transaction().execute(async (trx): Promise<EditDateOfBirthResult> => {
    const account = await findAccount(trx, options.userId);
    if (!account || account.state === 'deleted') return { status: 'not_found' };
    if (account.date_of_birth === options.dateOfBirth) return { status: 'unchanged' };

    const previousAge = ageOn(account.date_of_birth, options.now);
    const previousBand = bandOn(account.date_of_birth, options.now, options.bands);
    const nextAge = ageOn(options.dateOfBirth, options.now);
    const nextBand = bandOn(options.dateOfBirth, options.now, options.bands);
    const lockdown =
      under18(nextAge, options.bands) && !under18(previousAge, options.bands)
        ? agePrivacyDefaults(true)
        : undefined;

    await trx
      .updateTable('users')
      .set({
        date_of_birth: options.dateOfBirth,
        updated_at: options.now,
        ...(lockdown === undefined
          ? {}
          : {
              public_profile: lockdown.publicProfile,
              leaderboard_visible: lockdown.leaderboardVisible,
              security_notifications: lockdown.securityNotifications,
            }),
      })
      .where('id', '=', options.userId)
      .execute();
    await trx
      .insertInto('date_of_birth_changes')
      .values({
        id: randomUUIDv7(),
        user_id: options.userId,
        actor_id: options.actorId,
        reason: options.reason,
        previous_date_of_birth: account.date_of_birth,
        date_of_birth: options.dateOfBirth,
        created_at: options.now,
      })
      .execute();

    const actor = { type: 'user' as const, id: options.actorId };
    await writeEvent<Database, UserUpdatedData>(
      trx,
      userUpdatedEvent(options.userId, { fields: ['date_of_birth'] }, actor),
    );
    if (previousBand !== nextBand) {
      await writeEvent<Database, UserAgeBandChangedData>(
        trx,
        userAgeBandChangedEvent(
          options.userId,
          { previous_age_band: previousBand, age_band: nextBand },
          actor,
        ),
      );
    }

    return {
      status: 'updated',
      dateOfBirth: options.dateOfBirth,
      ageBand: nextBand,
      previousAgeBand: previousBand,
    };
  });
}
