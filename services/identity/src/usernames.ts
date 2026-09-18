import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import { type Kysely, sql } from 'kysely';

import { findAccount } from './accounts.ts';
import type { Database } from './database.ts';
import { type UserUpdatedData, userUpdatedEvent } from './events.ts';
import type { UsernameAction } from './metrics.ts';
import type { IdentityConfig } from './service.ts';

export type UsernameRuleReason = 'too_short' | 'too_long' | 'bad_charset';

export type ClaimUsernameResult =
  | { status: 'not_found' }
  | { status: 'invalid'; reason: UsernameRuleReason }
  | { status: 'unavailable' }
  | { status: 'unchanged' }
  | { status: 'cooldown'; availableAt: Date }
  | { status: 'limit' }
  | { status: 'saved'; action: UsernameAction; username: string; updatedAt: Date };

export type UsernameFailure = Exclude<ClaimUsernameResult, { status: 'saved' }>['status'];

export function canonicalUsername(username: string): string {
  return username.toLowerCase();
}

export function usernameCharsetRegex(charset: string): RegExp {
  return new RegExp(`^(?:${charset})+$`, 'u');
}

export function usernameRuleReason(
  username: string,
  settings: Pick<IdentityConfig['usernames'], 'min_length' | 'max_length' | 'charset'>,
): UsernameRuleReason | undefined {
  if (username.length < settings.min_length) return 'too_short';
  if (username.length > settings.max_length) return 'too_long';
  if (!usernameCharsetRegex(settings.charset).test(username)) return 'bad_charset';
  return undefined;
}

export function usernameReserved(
  username: string,
  settings: Pick<IdentityConfig['usernames'], 'reserved' | 'reserved_prefixes'>,
): boolean {
  const canonical = canonicalUsername(username);
  if (settings.reserved.some((name) => canonicalUsername(name) === canonical)) return true;
  return settings.reserved_prefixes.some((prefix) =>
    canonical.startsWith(canonicalUsername(prefix)),
  );
}

export async function lockUsername(db: Kysely<Database>, canonical: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext('qtiauth.usernames'), hashtext(${canonical}))`.execute(
    db,
  );
}

async function currentHolder(
  db: Kysely<Database>,
  canonical: string,
): Promise<{ id: string } | undefined> {
  return db
    .selectFrom('users')
    .select('id')
    .where('username_canonical', '=', canonical)
    .executeTakeFirst();
}

async function latestRelease(
  db: Kysely<Database>,
  canonical: string,
): Promise<{ user_id: string; released_at: Date } | undefined> {
  const row = await db
    .selectFrom('username_history')
    .select(['user_id', 'released_at'])
    .where('canonical', '=', canonical)
    .where('released_at', 'is not', null)
    .orderBy('released_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row?.released_at) return undefined;
  return { user_id: row.user_id, released_at: row.released_at };
}

async function changesInWindow(
  db: Kysely<Database>,
  userId: string,
  now: Date,
  windowMs: number,
): Promise<number> {
  const first = await db
    .selectFrom('username_history')
    .select('claimed_at')
    .where('user_id', '=', userId)
    .orderBy('claimed_at')
    .orderBy('id')
    .executeTakeFirst();
  if (first === undefined) return 0;
  const since = new Date(now.getTime() - windowMs);
  const rows = await db
    .selectFrom('username_history')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('user_id', '=', userId)
    .where('claimed_at', '>', first.claimed_at)
    .where('claimed_at', '>', since)
    .executeTakeFirst();
  return Number(rows?.count ?? 0);
}

export async function claimUsername(
  db: Kysely<Database>,
  options: {
    userId: string;
    username: string;
    settings: IdentityConfig['usernames'];
    isBlocked: (username: string) => Promise<boolean>;
    now: Date;
  },
): Promise<ClaimUsernameResult> {
  const { now, settings, username } = options;
  const invalid = usernameRuleReason(username, settings);
  if (invalid !== undefined) return { status: 'invalid', reason: invalid };
  const canonical = canonicalUsername(username);
  if (usernameReserved(canonical, settings)) return { status: 'unavailable' };

  const account = await findAccount(db, options.userId);
  if (!account || account.state === 'deleted') return { status: 'not_found' };
  if (account.username !== null && canonicalUsername(account.username) === canonical) {
    return { status: 'unchanged' };
  }

  if (await options.isBlocked(username)) return { status: 'unavailable' };

  return db.transaction().execute(async (trx): Promise<ClaimUsernameResult> => {
    await lockUsername(trx, canonical);
    const latest = await findAccount(trx, options.userId);
    if (!latest || latest.state === 'deleted') return { status: 'not_found' };
    if (latest.username !== null && canonicalUsername(latest.username) === canonical) {
      return { status: 'unchanged' };
    }

    const holder = await currentHolder(trx, canonical);
    if (holder !== undefined && holder.id !== options.userId) return { status: 'unavailable' };

    const released = await latestRelease(trx, canonical);
    const heldUntil =
      released === undefined ? 0 : released.released_at.getTime() + settings.release_hold;
    const held = released !== undefined && heldUntil > now.getTime();
    if (held && released.user_id !== options.userId) return { status: 'unavailable' };
    const reclaiming = held && released.user_id === options.userId;

    const changing = latest.username !== null;
    if (changing) {
      const lastChange = latest.username_updated_at ?? now;
      const availableAt = new Date(lastChange.getTime() + settings.change_cooldown);
      if (now < availableAt) return { status: 'cooldown', availableAt };
      const used = await changesInWindow(trx, options.userId, now, settings.change_window);
      if (used >= settings.changes_per_year) return { status: 'limit' };
    }

    if (changing) {
      await trx
        .updateTable('username_history')
        .set({ released_at: now })
        .where('user_id', '=', options.userId)
        .where('released_at', 'is', null)
        .execute();
    }
    await trx
      .updateTable('users')
      .set({
        username,
        username_canonical: canonical,
        username_updated_at: now,
        username_reset_required: false,
        updated_at: now,
      })
      .where('id', '=', options.userId)
      .execute();
    await trx
      .insertInto('username_history')
      .values({
        id: randomUUIDv7(),
        user_id: options.userId,
        username,
        canonical,
        claimed_at: now,
        released_at: null,
      })
      .execute();
    await writeEvent<Database, UserUpdatedData>(
      trx,
      userUpdatedEvent(options.userId, { fields: ['username'] }),
    );

    const action: UsernameAction = !changing ? 'claim' : reclaiming ? 'reclaim' : 'change';
    return { status: 'saved', action, username, updatedAt: now };
  });
}

export async function releaseCurrentUsername(
  trx: Kysely<Database>,
  options: { userId: string; now: Date },
): Promise<boolean> {
  const account = await findAccount(trx, options.userId);
  if (!account?.username) return false;
  await trx
    .updateTable('username_history')
    .set({ released_at: options.now })
    .where('user_id', '=', options.userId)
    .where('released_at', 'is', null)
    .execute();
  await trx
    .updateTable('users')
    .set({
      username: null,
      username_canonical: null,
      username_updated_at: options.now,
      username_reset_required: true,
      updated_at: options.now,
    })
    .where('id', '=', options.userId)
    .execute();
  return true;
}
