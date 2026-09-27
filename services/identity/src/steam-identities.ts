import { deletedRows } from '@qtiauth/db';
import type { Kysely } from 'kysely';

import type { Database } from './database.ts';

export const STEAM_IDENTITY_TYPE = 'steam';

export interface SteamLinkedUser {
  steam_id: string;
  user_id: string;
}

export async function findSteamLink(
  db: Kysely<Database>,
  steamId: string,
): Promise<{ user_id: string } | undefined> {
  const row = await db
    .selectFrom('identities')
    .select(['user_id'])
    .where('type', '=', STEAM_IDENTITY_TYPE)
    .where('subject', '=', steamId)
    .executeTakeFirst();
  return row ?? undefined;
}

export async function listSteamLinksPage(
  db: Kysely<Database>,
  options: { after: string | null; limit: number },
): Promise<SteamLinkedUser[]> {
  let query = db
    .selectFrom('identities')
    .select(['subject', 'user_id'])
    .where('type', '=', STEAM_IDENTITY_TYPE)
    .where('subject', 'is not', null);
  if (options.after !== null) {
    query = query.where('subject', '>', options.after);
  }
  const rows = await query.orderBy('subject', 'asc').limit(options.limit).execute();
  return rows.map((row) => ({ steam_id: row.subject ?? '', user_id: row.user_id }));
}

export async function recordSteamUnlink(
  db: Kysely<Database>,
  options: { steamId: string; cooldownMs: number; now: Date },
): Promise<void> {
  const cooldownUntil = new Date(options.now.getTime() + options.cooldownMs);
  await db
    .insertInto('steam_unlinks')
    .values({
      steam_id: options.steamId,
      unlinked_at: options.now,
      cooldown_until: cooldownUntil,
    })
    .onConflict((oc) =>
      oc.column('steam_id').doUpdateSet({
        unlinked_at: options.now,
        cooldown_until: cooldownUntil,
      }),
    )
    .execute();
}

export async function steamUnlinkCooldownEnd(
  db: Kysely<Database>,
  options: { steamId: string; now: Date },
): Promise<Date | null> {
  const row = await db
    .selectFrom('steam_unlinks')
    .select(['cooldown_until'])
    .where('steam_id', '=', options.steamId)
    .executeTakeFirst();
  if (!row) return null;
  if (row.cooldown_until <= options.now) return null;
  return row.cooldown_until;
}

export async function sweepSteamUnlinks(db: Kysely<Database>, now: Date): Promise<number> {
  const result = await db
    .deleteFrom('steam_unlinks')
    .where('cooldown_until', '<=', now)
    .executeTakeFirst();
  return deletedRows(result);
}
