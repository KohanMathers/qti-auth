import { randomUUID } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import { GAME_ACHIEVEMENT_DESCRIPTION_MAX, GAME_ACHIEVEMENT_NAME_MAX } from '@qtiauth/config';
import { updatedRows } from '@qtiauth/db';
import type { EventActor, GameTrustLevel } from '@qtiauth/events';
import type { Kysely, Selectable } from 'kysely';

import type {
  AchievementsTable,
  AchievementUnlocksTable,
  Database,
  GamesTable,
} from './database.ts';
import {
  achievementProgressedEvent,
  type AchievementProgressedData,
  achievementRevokedEvent,
  type AchievementRevokedData,
  achievementUnlockedEvent,
  type AchievementUnlockedData,
  type AuditRecordedData,
  auditRecordedEvent,
} from './events.ts';

export interface AchievementRecord {
  id: string;
  game_id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  points: number;
  hidden: boolean;
  progress_target: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface AchievementUnlockRecord {
  id: string;
  achievement_id: string;
  user_id: string;
  progress: number;
  unlocked_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AchievementRarityRecord {
  achievement_id: string;
  owners: number;
  unlocks: number;
  rarity: number;
  computed_at: Date;
}

export interface AchievementView extends AchievementRecord {
  rarity: number | null;
}

export interface PlayerAchievementView extends AchievementView {
  progress: number;
  unlocked_at: Date | null;
}

export type AchievementWriteError = 'not_found' | 'slug_taken' | 'invalid';
export type UnlockOutcome =
  | { status: 'ok'; unlock: AchievementUnlockRecord; unlocked: boolean; changed: boolean }
  | { status: 'not_found' }
  | { status: 'not_progress' };

export type ProgressOutcome =
  | { status: 'ok'; unlock: AchievementUnlockRecord; unlocked: boolean; changed: boolean }
  | { status: 'not_found' }
  | { status: 'not_progress' }
  | { status: 'invalid' };

export type RevokeOutcome =
  | { status: 'ok'; unlock: AchievementUnlockRecord; achievement: AchievementRecord }
  | { status: 'not_found' }
  | { status: 'not_unlocked' };

export interface AchievementFields {
  slug?: string;
  name?: string;
  description?: string;
  icon?: string | null;
  points?: number;
  hidden?: boolean;
  progress_target?: number | null;
}

function achievementRecord(row: Selectable<AchievementsTable>): AchievementRecord {
  return row;
}

function unlockRecord(row: Selectable<AchievementUnlocksTable>): AchievementUnlockRecord {
  return row;
}

function trimmed(value: string, max: number): string | undefined {
  const text = value.trim();
  if (text.length === 0 || text.length > max) return undefined;
  return text;
}

async function slugTaken(
  db: Kysely<Database>,
  gameId: string,
  slug: string,
  exceptId?: string,
): Promise<boolean> {
  let query = db
    .selectFrom('achievements')
    .select('id')
    .where('game_id', '=', gameId)
    .where('slug', '=', slug);
  if (exceptId !== undefined) query = query.where('id', '!=', exceptId);
  const row = await query.executeTakeFirst();
  return row !== undefined;
}

async function writeAudit(
  db: Kysely<Database>,
  actor: EventActor,
  action: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await writeEvent<Database, AuditRecordedData>(
    db,
    auditRecordedEvent(actor, { action, target_type: targetType, target_id: targetId }),
  );
}

export function isProgressAchievement(record: AchievementRecord): boolean {
  return record.progress_target !== null && record.progress_target > 0;
}

export function unlockProgress(record: AchievementRecord, raw: number): number {
  if (!isProgressAchievement(record) || record.progress_target === null) return 0;
  if (raw < 0) return 0;
  return raw > record.progress_target ? record.progress_target : raw;
}

export async function listAchievements(
  db: Kysely<Database>,
  gameId: string,
): Promise<AchievementRecord[]> {
  const rows = await db
    .selectFrom('achievements')
    .selectAll()
    .where('game_id', '=', gameId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(achievementRecord);
}

export async function getAchievement(
  db: Kysely<Database>,
  gameId: string,
  slug: string,
): Promise<AchievementRecord | undefined> {
  const row = await db
    .selectFrom('achievements')
    .selectAll()
    .where('game_id', '=', gameId)
    .where('slug', '=', slug)
    .executeTakeFirst();
  return row ? achievementRecord(row) : undefined;
}

async function loadRarity(
  db: Kysely<Database>,
  achievementIds: readonly string[],
): Promise<Map<string, number>> {
  if (achievementIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('achievement_rarity')
    .select(['achievement_id', 'rarity'])
    .where('achievement_id', 'in', [...achievementIds])
    .execute();
  return new Map(rows.map((row) => [row.achievement_id, row.rarity]));
}

export function withRarity(
  achievements: readonly AchievementRecord[],
  rarities: ReadonlyMap<string, number>,
): AchievementView[] {
  return achievements.map((record) => ({
    ...record,
    rarity: rarities.get(record.id) ?? null,
  }));
}

export async function listAchievementViews(
  db: Kysely<Database>,
  gameId: string,
): Promise<AchievementView[]> {
  const rows = await listAchievements(db, gameId);
  const rarities = await loadRarity(
    db,
    rows.map((row) => row.id),
  );
  return withRarity(rows, rarities);
}

export async function listPlayerAchievements(
  db: Kysely<Database>,
  options: { gameId: string; userId: string },
): Promise<PlayerAchievementView[]> {
  const achievements = await listAchievements(db, options.gameId);
  if (achievements.length === 0) return [];
  const rarities = await loadRarity(
    db,
    achievements.map((row) => row.id),
  );
  const unlocks = await db
    .selectFrom('achievement_unlocks')
    .select(['achievement_id', 'progress', 'unlocked_at'])
    .where('user_id', '=', options.userId)
    .where('revoked_at', 'is', null)
    .where(
      'achievement_id',
      'in',
      achievements.map((row) => row.id),
    )
    .execute();
  const byAchievement = new Map(unlocks.map((row) => [row.achievement_id, row]));
  return achievements.map((record) => {
    const unlock = byAchievement.get(record.id);
    return {
      ...record,
      rarity: rarities.get(record.id) ?? null,
      progress: unlock?.progress ?? 0,
      unlocked_at: unlock?.unlocked_at ?? null,
    };
  });
}

export async function createAchievement(
  db: Kysely<Database>,
  options: {
    gameId: string;
    slug: string;
    name: string;
    description: string;
    icon: string | null;
    points: number;
    hidden: boolean;
    progress_target: number | null;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; achievement: AchievementRecord } | { status: AchievementWriteError }> {
  const name = trimmed(options.name, GAME_ACHIEVEMENT_NAME_MAX);
  const description = options.description.trim();
  if (name === undefined || description.length > GAME_ACHIEVEMENT_DESCRIPTION_MAX) {
    return { status: 'invalid' };
  }
  if (options.progress_target !== null && options.progress_target < 1) return { status: 'invalid' };
  return db.transaction().execute(async (trx) => {
    if (await slugTaken(trx, options.gameId, options.slug)) return { status: 'slug_taken' };
    const row = await trx
      .insertInto('achievements')
      .values({
        id: randomUUID(),
        game_id: options.gameId,
        slug: options.slug,
        name,
        description,
        icon: options.icon,
        points: options.points,
        hidden: options.hidden,
        progress_target: options.progress_target,
        created_at: options.now,
        updated_at: options.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, options.actor, 'games.achievement.created', 'achievement', row.id);
    return { status: 'ok', achievement: achievementRecord(row) };
  });
}

export async function updateAchievement(
  db: Kysely<Database>,
  options: AchievementFields & {
    gameId: string;
    currentSlug: string;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; achievement: AchievementRecord } | { status: AchievementWriteError }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('achievements')
      .selectAll()
      .where('game_id', '=', options.gameId)
      .where('slug', '=', options.currentSlug)
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    const patch: Partial<Selectable<AchievementsTable>> = { updated_at: options.now };
    if (options.slug !== undefined && options.slug !== current.slug) {
      if (await slugTaken(trx, options.gameId, options.slug, current.id)) {
        return { status: 'slug_taken' };
      }
      patch.slug = options.slug;
    }
    if (options.name !== undefined) {
      const name = trimmed(options.name, GAME_ACHIEVEMENT_NAME_MAX);
      if (name === undefined) return { status: 'invalid' };
      patch.name = name;
    }
    if (options.description !== undefined) {
      const description = options.description.trim();
      if (description.length > GAME_ACHIEVEMENT_DESCRIPTION_MAX) return { status: 'invalid' };
      patch.description = description;
    }
    if (options.icon !== undefined) patch.icon = options.icon;
    if (options.points !== undefined) patch.points = options.points;
    if (options.hidden !== undefined) patch.hidden = options.hidden;
    if (options.progress_target !== undefined) {
      if (options.progress_target !== null && options.progress_target < 1) {
        return { status: 'invalid' };
      }
      patch.progress_target = options.progress_target;
    }
    await trx.updateTable('achievements').set(patch).where('id', '=', current.id).execute();
    await writeAudit(trx, options.actor, 'games.achievement.updated', 'achievement', current.id);
    const row = await trx
      .selectFrom('achievements')
      .selectAll()
      .where('id', '=', current.id)
      .executeTakeFirstOrThrow();
    return { status: 'ok', achievement: achievementRecord(row) };
  });
}

export async function deleteAchievement(
  db: Kysely<Database>,
  options: { gameId: string; slug: string; actor: EventActor },
): Promise<{ status: 'ok' } | { status: 'not_found' }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('achievements')
      .select(['id'])
      .where('game_id', '=', options.gameId)
      .where('slug', '=', options.slug)
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    await writeAudit(trx, options.actor, 'games.achievement.deleted', 'achievement', current.id);
    await trx.deleteFrom('achievements').where('id', '=', current.id).execute();
    return { status: 'ok' };
  });
}

interface AchievementLookup {
  achievement: AchievementRecord;
  game: Pick<Selectable<GamesTable>, 'id' | 'slug'>;
}

async function findByGameSlug(
  db: Kysely<Database>,
  options: { gameId: string; slug: string },
): Promise<AchievementLookup | undefined> {
  const row = await db
    .selectFrom('achievements')
    .innerJoin('games', 'games.id', 'achievements.game_id')
    .selectAll('achievements')
    .select(['games.id as game_row_id', 'games.slug as game_slug'])
    .where('achievements.game_id', '=', options.gameId)
    .where('achievements.slug', '=', options.slug)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    achievement: achievementRecord({
      id: row.id,
      game_id: row.game_id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      icon: row.icon,
      points: row.points,
      hidden: row.hidden,
      progress_target: row.progress_target,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }),
    game: { id: row.game_row_id, slug: row.game_slug },
  };
}

async function existingUnlock(
  db: Kysely<Database>,
  achievementId: string,
  userId: string,
): Promise<AchievementUnlockRecord | undefined> {
  const row = await db
    .selectFrom('achievement_unlocks')
    .selectAll()
    .where('achievement_id', '=', achievementId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row ? unlockRecord(row) : undefined;
}

async function writeUnlockedEvent(
  db: Kysely<Database>,
  options: {
    unlock: AchievementUnlockRecord;
    achievement: AchievementRecord;
    game: { slug: string };
    trust: GameTrustLevel;
    actor: EventActor;
  },
): Promise<void> {
  if (options.unlock.unlocked_at === null) return;
  const data: AchievementUnlockedData = {
    unlock_id: options.unlock.id,
    achievement_id: options.achievement.id,
    user_id: options.unlock.user_id,
    game_id: options.achievement.game_id,
    achievement_slug: options.achievement.slug,
    trust: options.trust,
    unlocked_at: options.unlock.unlocked_at.toISOString(),
  };
  await writeEvent<Database, AchievementUnlockedData>(
    db,
    achievementUnlockedEvent(data, options.actor),
  );
}

async function writeProgressedEvent(
  db: Kysely<Database>,
  options: {
    unlock: AchievementUnlockRecord;
    achievement: AchievementRecord;
    trust: GameTrustLevel;
    actor: EventActor;
  },
): Promise<void> {
  if (options.achievement.progress_target === null) return;
  const data: AchievementProgressedData = {
    unlock_id: options.unlock.id,
    achievement_id: options.achievement.id,
    user_id: options.unlock.user_id,
    game_id: options.achievement.game_id,
    achievement_slug: options.achievement.slug,
    trust: options.trust,
    progress: options.unlock.progress,
    progress_target: options.achievement.progress_target,
  };
  await writeEvent<Database, AchievementProgressedData>(
    db,
    achievementProgressedEvent(data, options.actor),
  );
}

export async function unlockAchievement(
  db: Kysely<Database>,
  options: {
    gameId: string;
    slug: string;
    userId: string;
    trust: GameTrustLevel;
    actor: EventActor;
    now: Date;
  },
): Promise<UnlockOutcome> {
  const lookup = await findByGameSlug(db, { gameId: options.gameId, slug: options.slug });
  if (!lookup) return { status: 'not_found' };
  const { achievement } = lookup;
  if (isProgressAchievement(achievement)) return { status: 'not_progress' };
  return db.transaction().execute(async (trx) => {
    const current = await existingUnlock(trx, achievement.id, options.userId);
    if (current && current.unlocked_at !== null && current.revoked_at === null) {
      return { status: 'ok' as const, unlock: current, unlocked: false, changed: false };
    }
    if (current) {
      const result = await trx
        .updateTable('achievement_unlocks')
        .set({
          progress: 0,
          unlocked_at: options.now,
          revoked_at: null,
          revoke_reason: null,
          updated_at: options.now,
        })
        .where('id', '=', current.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const unlock = unlockRecord(result);
      await writeUnlockedEvent(trx, {
        unlock,
        achievement,
        game: lookup.game,
        trust: options.trust,
        actor: options.actor,
      });
      return { status: 'ok' as const, unlock, unlocked: true, changed: true };
    }
    const inserted = await trx
      .insertInto('achievement_unlocks')
      .values({
        id: randomUUID(),
        achievement_id: achievement.id,
        user_id: options.userId,
        progress: 0,
        unlocked_at: options.now,
        revoked_at: null,
        revoke_reason: null,
        created_at: options.now,
        updated_at: options.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const unlock = unlockRecord(inserted);
    await writeUnlockedEvent(trx, {
      unlock,
      achievement,
      game: lookup.game,
      trust: options.trust,
      actor: options.actor,
    });
    return { status: 'ok' as const, unlock, unlocked: true, changed: true };
  });
}

export async function progressAchievement(
  db: Kysely<Database>,
  options: {
    gameId: string;
    slug: string;
    userId: string;
    progress: number;
    trust: GameTrustLevel;
    actor: EventActor;
    now: Date;
  },
): Promise<ProgressOutcome> {
  if (options.progress < 0 || !Number.isFinite(options.progress)) return { status: 'invalid' };
  const lookup = await findByGameSlug(db, { gameId: options.gameId, slug: options.slug });
  if (!lookup) return { status: 'not_found' };
  const { achievement } = lookup;
  if (!isProgressAchievement(achievement) || achievement.progress_target === null) {
    return { status: 'not_progress' };
  }
  const target = achievement.progress_target;
  const capped = unlockProgress(achievement, Math.floor(options.progress));
  return db.transaction().execute(async (trx) => {
    const current = await existingUnlock(trx, achievement.id, options.userId);
    if (current && current.unlocked_at !== null && current.revoked_at === null) {
      return { status: 'ok' as const, unlock: current, unlocked: false, changed: false };
    }
    const nextProgress = current ? Math.max(current.progress, capped) : capped;
    const willUnlock = nextProgress >= target;
    if (current) {
      if (nextProgress === current.progress && current.revoked_at === null && !willUnlock) {
        return { status: 'ok' as const, unlock: current, unlocked: false, changed: false };
      }
      const result = await trx
        .updateTable('achievement_unlocks')
        .set({
          progress: nextProgress,
          unlocked_at: willUnlock ? options.now : current.unlocked_at,
          revoked_at: null,
          revoke_reason: null,
          updated_at: options.now,
        })
        .where('id', '=', current.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const unlock = unlockRecord(result);
      if (willUnlock) {
        await writeUnlockedEvent(trx, {
          unlock,
          achievement,
          game: lookup.game,
          trust: options.trust,
          actor: options.actor,
        });
      } else {
        await writeProgressedEvent(trx, {
          unlock,
          achievement,
          trust: options.trust,
          actor: options.actor,
        });
      }
      return { status: 'ok' as const, unlock, unlocked: willUnlock, changed: true };
    }
    const inserted = await trx
      .insertInto('achievement_unlocks')
      .values({
        id: randomUUID(),
        achievement_id: achievement.id,
        user_id: options.userId,
        progress: nextProgress,
        unlocked_at: willUnlock ? options.now : null,
        revoked_at: null,
        revoke_reason: null,
        created_at: options.now,
        updated_at: options.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const unlock = unlockRecord(inserted);
    if (willUnlock) {
      await writeUnlockedEvent(trx, {
        unlock,
        achievement,
        game: lookup.game,
        trust: options.trust,
        actor: options.actor,
      });
    } else {
      await writeProgressedEvent(trx, {
        unlock,
        achievement,
        trust: options.trust,
        actor: options.actor,
      });
    }
    return { status: 'ok' as const, unlock, unlocked: willUnlock, changed: true };
  });
}

export async function revokeUnlock(
  db: Kysely<Database>,
  options: { unlockId: string; reason: string; actor: EventActor; now: Date },
): Promise<RevokeOutcome> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('achievement_unlocks')
      .innerJoin('achievements', 'achievements.id', 'achievement_unlocks.achievement_id')
      .selectAll('achievement_unlocks')
      .select([
        'achievements.game_id as achievement_game_id',
        'achievements.slug as achievement_slug',
        'achievements.name as achievement_name',
        'achievements.description as achievement_description',
        'achievements.icon as achievement_icon',
        'achievements.points as achievement_points',
        'achievements.hidden as achievement_hidden',
        'achievements.progress_target as achievement_progress_target',
        'achievements.created_at as achievement_created_at',
        'achievements.updated_at as achievement_updated_at',
      ])
      .where('achievement_unlocks.id', '=', options.unlockId)
      .executeTakeFirst();
    if (!row) return { status: 'not_found' as const };
    if (row.unlocked_at === null || row.revoked_at !== null) {
      return { status: 'not_unlocked' as const };
    }
    const result = await trx
      .updateTable('achievement_unlocks')
      .set({ revoked_at: options.now, revoke_reason: options.reason, updated_at: options.now })
      .where('id', '=', row.id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (updatedRows(result) !== 1) return { status: 'not_unlocked' as const };
    const achievement: AchievementRecord = {
      id: row.achievement_id,
      game_id: row.achievement_game_id,
      slug: row.achievement_slug,
      name: row.achievement_name,
      description: row.achievement_description,
      icon: row.achievement_icon,
      points: row.achievement_points,
      hidden: row.achievement_hidden,
      progress_target: row.achievement_progress_target,
      created_at: row.achievement_created_at,
      updated_at: row.achievement_updated_at,
    };
    const unlock: AchievementUnlockRecord = {
      id: row.id,
      achievement_id: row.achievement_id,
      user_id: row.user_id,
      progress: row.progress,
      unlocked_at: row.unlocked_at,
      revoked_at: options.now,
      revoke_reason: options.reason,
      created_at: row.created_at,
      updated_at: options.now,
    };
    const data: AchievementRevokedData = {
      unlock_id: unlock.id,
      achievement_id: achievement.id,
      user_id: unlock.user_id,
      game_id: achievement.game_id,
      achievement_slug: achievement.slug,
      reason: options.reason,
    };
    await writeEvent<Database, AchievementRevokedData>(
      trx,
      achievementRevokedEvent(data, options.actor),
    );
    await writeAudit(
      trx,
      options.actor,
      'games.achievement.unlock_revoked',
      'achievement_unlock',
      unlock.id,
    );
    return { status: 'ok' as const, unlock, achievement };
  });
}

export async function recomputeRarity(
  db: Kysely<Database>,
  now: Date,
): Promise<{ achievements: number; owners: number }> {
  return db.transaction().execute(async (trx) => {
    const achievements = await trx.selectFrom('achievements').select(['id', 'game_id']).execute();
    if (achievements.length === 0) return { achievements: 0, owners: 0 };
    const owners = await trx
      .selectFrom('entitlements')
      .innerJoin('products', 'products.id', 'entitlements.product_id')
      .select(['products.game_id as game_id', 'entitlements.user_id as user_id'])
      .where('entitlements.revoked_at', 'is', null)
      .where((eb) =>
        eb.or([eb('entitlements.expires_at', 'is', null), eb('entitlements.expires_at', '>', now)]),
      )
      .distinct()
      .execute();
    const ownersByGame = new Map<string, Set<string>>();
    for (const row of owners) {
      let set = ownersByGame.get(row.game_id);
      if (!set) {
        set = new Set();
        ownersByGame.set(row.game_id, set);
      }
      set.add(row.user_id);
    }
    const unlocks = await trx
      .selectFrom('achievement_unlocks')
      .select(['achievement_id', (eb) => eb.fn.countAll<string>().as('count')])
      .where('unlocked_at', 'is not', null)
      .where('revoked_at', 'is', null)
      .groupBy('achievement_id')
      .execute();
    const unlocksByAchievement = new Map(
      unlocks.map((row) => [row.achievement_id, Number(row.count)]),
    );
    const totalOwners = owners.length;
    for (const record of achievements) {
      const gameOwners = ownersByGame.get(record.game_id)?.size ?? 0;
      const unlockCount = unlocksByAchievement.get(record.id) ?? 0;
      const rarity = gameOwners === 0 ? 0 : unlockCount / gameOwners;
      await trx
        .insertInto('achievement_rarity')
        .values({
          achievement_id: record.id,
          owners: gameOwners,
          unlocks: unlockCount,
          rarity,
          computed_at: now,
        })
        .onConflict((oc) =>
          oc.column('achievement_id').doUpdateSet({
            owners: gameOwners,
            unlocks: unlockCount,
            rarity,
            computed_at: now,
          }),
        )
        .execute();
    }
    return { achievements: achievements.length, owners: totalOwners };
  });
}

export async function exportUserAchievements(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('achievement_unlocks')
    .innerJoin('achievements', 'achievements.id', 'achievement_unlocks.achievement_id')
    .innerJoin('games', 'games.id', 'achievements.game_id')
    .select([
      'achievement_unlocks.id as id',
      'games.slug as game_slug',
      'achievements.slug as achievement_slug',
      'achievements.name as achievement_name',
      'achievement_unlocks.progress as progress',
      'achievement_unlocks.unlocked_at as unlocked_at',
      'achievement_unlocks.revoked_at as revoked_at',
      'achievement_unlocks.revoke_reason as revoke_reason',
    ])
    .where('achievement_unlocks.user_id', '=', userId)
    .orderBy('achievement_unlocks.unlocked_at', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    game_slug: row.game_slug,
    achievement_slug: row.achievement_slug,
    achievement_name: row.achievement_name,
    progress: row.progress,
    unlocked_at: row.unlocked_at?.toISOString() ?? null,
    revoked_at: row.revoked_at?.toISOString() ?? null,
    revoke_reason: row.revoke_reason,
  }));
}

export async function eraseUserAchievements(db: Kysely<Database>, userId: string): Promise<void> {
  await db.deleteFrom('achievement_unlocks').where('user_id', '=', userId).execute();
}
