import { writeEvent } from '@qtiauth/bus';
import { sql, type Expression, type Kysely, type SqlBool } from 'kysely';

import { dateOfBirthColumn } from './accounts.ts';
import { type AgeBands, bandOn, isLeapYear, previousUtcDay, utcDay } from './age.ts';
import type { Database } from './database.ts';
import { type UserAgeBandChangedData, userAgeBandChangedEvent } from './events.ts';

export const AGE_RECOMPUTE_JOB = 'age.recompute_bands';

export function birthdayMatch(now: Date): Expression<SqlBool> {
  const mmdd = utcDay(now).slice(5, 10);
  const includeFeb29 = mmdd === '03-01' && !isLeapYear(now.getUTCFullYear());
  if (includeFeb29) {
    return sql<SqlBool>`to_char(users.date_of_birth, 'MM-DD') in (${mmdd}, '02-29')`;
  }
  return sql<SqlBool>`to_char(users.date_of_birth, 'MM-DD') = ${mmdd}`;
}

export async function recomputeAgeBands(
  db: Kysely<Database>,
  options: { bands: AgeBands; now: Date },
): Promise<number> {
  const today = new Date(`${utcDay(options.now)}T00:00:00.000Z`);
  const yesterday = previousUtcDay(today);
  const rows = await db
    .selectFrom('users')
    .select(['id', dateOfBirthColumn.as('date_of_birth')])
    .where('state', '!=', 'deleted')
    .where(birthdayMatch(today))
    .execute();

  let changed = 0;
  for (const row of rows) {
    const previous = bandOn(row.date_of_birth, yesterday, options.bands);
    const current = bandOn(row.date_of_birth, today, options.bands);
    if (previous === current) continue;
    await db.transaction().execute(async (trx) => {
      await writeEvent<Database, UserAgeBandChangedData>(
        trx,
        userAgeBandChangedEvent(row.id, {
          previous_age_band: previous,
          age_band: current,
        }),
      );
    });
    changed += 1;
  }
  return changed;
}
