import { deletedRows } from '@qtiauth/db';
import { type Kysely, sql } from 'kysely';

import type { Database } from './database.ts';

export interface FailureDelaySettings {
  step: number;
  max: number;
}

export function failureWait(failures: number, settings: FailureDelaySettings): number {
  if (failures <= 0) return 0;
  return Math.min(settings.max, failures * settings.step);
}

export function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function countedFailures(
  db: Kysely<Database>,
  keys: { ip: string; account: string },
): Promise<number> {
  const rows = await db
    .selectFrom('auth_failures')
    .select('failures')
    .where((eb) =>
      eb.or([
        eb.and([eb('kind', '=', 'ip'), eb('key', '=', keys.ip)]),
        eb.and([eb('kind', '=', 'account'), eb('key', '=', keys.account)]),
      ]),
    )
    .execute();
  return rows.reduce((max, row) => Math.max(max, row.failures), 0);
}

export async function recordAuthFailure(
  db: Kysely<Database>,
  keys: { ip: string; account: string },
  now: Date,
): Promise<void> {
  for (const [kind, key] of [
    ['ip', keys.ip],
    ['account', keys.account],
  ] as const) {
    await db
      .insertInto('auth_failures')
      .values({ kind, key, failures: 1, updated_at: now })
      .onConflict((conflict) =>
        conflict.columns(['kind', 'key']).doUpdateSet({
          failures: sql`auth_failures.failures + 1`,
          updated_at: now,
        }),
      )
      .execute();
  }
}

export async function clearAuthFailures(
  db: Kysely<Database>,
  keys: { ip: string; account: string },
): Promise<void> {
  await db
    .deleteFrom('auth_failures')
    .where((eb) =>
      eb.or([
        eb.and([eb('kind', '=', 'ip'), eb('key', '=', keys.ip)]),
        eb.and([eb('kind', '=', 'account'), eb('key', '=', keys.account)]),
      ]),
    )
    .execute();
}

export async function sweepAuthFailures(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<number> {
  const result = await db
    .deleteFrom('auth_failures')
    .where('updated_at', '<', new Date(options.now.getTime() - options.retention))
    .execute();
  return deletedRows(result);
}
