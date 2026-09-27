import { randomUUID } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import { updatedRows } from '@qtiauth/db';
import type { EventActor, GameTrustLevel } from '@qtiauth/events';
import type { Kysely, Selectable } from 'kysely';

import type {
  Database,
  LeaderboardEntriesTable,
  LeaderboardResetPeriod,
  LeaderboardSort,
  LeaderboardsTable,
  PlaytimeSessionsTable,
  StatAggregation,
  StatAuthority,
  StatDefinitionsTable,
  StatType,
  StatValuesTable,
} from './database.ts';
import {
  type AuditRecordedData,
  auditRecordedEvent,
  type LeaderboardEntryRemovedData,
  leaderboardEntryRemovedEvent,
  type PlaytimeEndedData,
  playtimeEndedEvent,
  type StatUpdatedData,
  statUpdatedEvent,
} from './events.ts';

export const GAME_STAT_NAME_MAX = 120;
export const GAME_LEADERBOARD_NAME_MAX = 120;
export const GAME_CUSTOM_DATA_MAX_BYTES = 32_768;
export const HIDDEN_ENTRY_DISPLAY = 'Hidden player';

export interface StatDefinitionRecord {
  id: string;
  game_id: string;
  key: string;
  type: StatType;
  aggregation: StatAggregation;
  authority: StatAuthority;
  max_delta_per_update: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface StatValueRecord {
  stat_id: string;
  user_id: string;
  value: number;
  updates: number;
  updated_at: Date;
}

export interface LeaderboardRecord {
  id: string;
  stat_id: string;
  slug: string;
  name: string;
  sort: LeaderboardSort;
  reset_period: LeaderboardResetPeriod;
  period_started_at: Date;
  period_ends_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface LeaderboardEntryRecord {
  leaderboard_id: string;
  period_started_at: Date;
  user_id: string;
  score: number;
  hidden: boolean;
  removed_at: Date | null;
  removed_reason: string | null;
  updated_at: Date;
}

export interface PlaytimeSessionRecord {
  id: string;
  user_id: string;
  game_id: string;
  started_at: Date;
  last_heartbeat_at: Date;
  ended_at: Date | null;
  duration_seconds: number;
}

export type StatWriteError = 'not_found' | 'key_taken' | 'invalid';
export type LeaderboardWriteError = 'not_found' | 'slug_taken' | 'invalid' | 'needs_game_authority';

export type StatUpdateOutcome =
  | { status: 'ok'; stat: StatDefinitionRecord; value: StatValueRecord; changed: boolean }
  | { status: 'not_found' }
  | { status: 'authority_mismatch' }
  | { status: 'delta_too_large' };

export type CustomDataWriteOutcome =
  { status: 'ok'; data: Record<string, unknown> } | { status: 'too_large' };

export interface StatFields {
  key?: string;
  type?: StatType;
  aggregation?: StatAggregation;
  authority?: StatAuthority;
  max_delta_per_update?: number | null;
}

export interface LeaderboardFields {
  slug?: string;
  name?: string;
  sort?: LeaderboardSort;
  reset_period?: LeaderboardResetPeriod;
}

function statRecord(row: Selectable<StatDefinitionsTable>): StatDefinitionRecord {
  return row;
}

function valueRecord(row: Selectable<StatValuesTable>): StatValueRecord {
  return {
    stat_id: row.stat_id,
    user_id: row.user_id,
    value: row.value,
    updates: row.updates,
    updated_at: row.updated_at,
  };
}

function leaderboardRecord(row: Selectable<LeaderboardsTable>): LeaderboardRecord {
  return row;
}

function leaderboardEntryRecord(row: Selectable<LeaderboardEntriesTable>): LeaderboardEntryRecord {
  return {
    leaderboard_id: row.leaderboard_id,
    period_started_at: row.period_started_at,
    user_id: row.user_id,
    score: row.score,
    hidden: row.hidden,
    removed_at: row.removed_at,
    removed_reason: row.removed_reason,
    updated_at: row.updated_at,
  };
}

function playtimeSessionRecord(row: Selectable<PlaytimeSessionsTable>): PlaytimeSessionRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    game_id: row.game_id,
    started_at: row.started_at,
    last_heartbeat_at: row.last_heartbeat_at,
    ended_at: row.ended_at,
    duration_seconds: row.duration_seconds,
  };
}

function trimmed(value: string, max: number): string | undefined {
  const text = value.trim();
  if (text.length === 0 || text.length > max) return undefined;
  return text;
}

async function statKeyTaken(
  db: Kysely<Database>,
  gameId: string,
  key: string,
  exceptId?: string,
): Promise<boolean> {
  let query = db
    .selectFrom('stat_definitions')
    .select('id')
    .where('game_id', '=', gameId)
    .where('key', '=', key);
  if (exceptId !== undefined) query = query.where('id', '!=', exceptId);
  const row = await query.executeTakeFirst();
  return row !== undefined;
}

async function leaderboardSlugTaken(
  db: Kysely<Database>,
  statId: string,
  slug: string,
  exceptId?: string,
): Promise<boolean> {
  let query = db
    .selectFrom('leaderboards')
    .select('id')
    .where('stat_id', '=', statId)
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

export function aggregateStat(
  aggregation: StatAggregation,
  current: number,
  incoming: number,
): number {
  if (aggregation === 'sum') return current + incoming;
  if (aggregation === 'max') return incoming > current ? incoming : current;
  if (aggregation === 'min') return incoming < current ? incoming : current;
  return incoming;
}

function periodBounds(
  reset: LeaderboardResetPeriod,
  now: Date,
): { started_at: Date; ends_at: Date | null } {
  if (reset === 'never' || reset.startsWith('season:')) {
    return { started_at: now, ends_at: null };
  }
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (reset === 'daily') {
    const start = new Date(Date.UTC(y, m, d));
    const end = new Date(Date.UTC(y, m, d + 1));
    return { started_at: start, ends_at: end };
  }
  if (reset === 'weekly') {
    const weekday = now.getUTCDay();
    const monday = weekday === 0 ? 6 : weekday - 1;
    const start = new Date(Date.UTC(y, m, d - monday));
    const end = new Date(Date.UTC(y, m, d - monday + 7));
    return { started_at: start, ends_at: end };
  }
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  return { started_at: start, ends_at: end };
}

function nextPeriod(
  reset: LeaderboardResetPeriod,
  currentEnd: Date,
): { started_at: Date; ends_at: Date | null } {
  return periodBounds(reset, currentEnd);
}

function customDataSize(data: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(data), 'utf8');
}

function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function listStats(
  db: Kysely<Database>,
  gameId: string,
): Promise<StatDefinitionRecord[]> {
  const rows = await db
    .selectFrom('stat_definitions')
    .selectAll()
    .where('game_id', '=', gameId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(statRecord);
}

export async function getStat(
  db: Kysely<Database>,
  gameId: string,
  key: string,
): Promise<StatDefinitionRecord | undefined> {
  const row = await db
    .selectFrom('stat_definitions')
    .selectAll()
    .where('game_id', '=', gameId)
    .where('key', '=', key)
    .executeTakeFirst();
  return row ? statRecord(row) : undefined;
}

export async function createStat(
  db: Kysely<Database>,
  options: {
    gameId: string;
    key: string;
    type: StatType;
    aggregation: StatAggregation;
    authority: StatAuthority;
    max_delta_per_update: number | null;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; stat: StatDefinitionRecord } | { status: StatWriteError }> {
  const key = trimmed(options.key, 80);
  if (key === undefined) return { status: 'invalid' };
  if (
    options.max_delta_per_update !== null &&
    (!Number.isFinite(options.max_delta_per_update) || options.max_delta_per_update <= 0)
  ) {
    return { status: 'invalid' };
  }
  return db.transaction().execute(async (trx) => {
    if (await statKeyTaken(trx, options.gameId, key)) return { status: 'key_taken' };
    const row = await trx
      .insertInto('stat_definitions')
      .values({
        id: randomUUID(),
        game_id: options.gameId,
        key,
        type: options.type,
        aggregation: options.aggregation,
        authority: options.authority,
        max_delta_per_update: options.max_delta_per_update,
        created_at: options.now,
        updated_at: options.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, options.actor, 'games.stat.created', 'stat', row.id);
    return { status: 'ok', stat: statRecord(row) };
  });
}

export async function updateStat(
  db: Kysely<Database>,
  options: StatFields & {
    gameId: string;
    currentKey: string;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; stat: StatDefinitionRecord } | { status: StatWriteError }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('stat_definitions')
      .selectAll()
      .where('game_id', '=', options.gameId)
      .where('key', '=', options.currentKey)
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    const patch: Partial<Selectable<StatDefinitionsTable>> = { updated_at: options.now };
    if (options.key !== undefined && options.key !== current.key) {
      const next = trimmed(options.key, 80);
      if (next === undefined) return { status: 'invalid' };
      if (await statKeyTaken(trx, options.gameId, next, current.id)) return { status: 'key_taken' };
      patch.key = next;
    }
    if (options.type !== undefined) patch.type = options.type;
    if (options.aggregation !== undefined) patch.aggregation = options.aggregation;
    if (options.authority !== undefined) patch.authority = options.authority;
    if (options.max_delta_per_update !== undefined) {
      if (
        options.max_delta_per_update !== null &&
        (!Number.isFinite(options.max_delta_per_update) || options.max_delta_per_update <= 0)
      ) {
        return { status: 'invalid' };
      }
      patch.max_delta_per_update = options.max_delta_per_update;
    }
    await trx.updateTable('stat_definitions').set(patch).where('id', '=', current.id).execute();
    await writeAudit(trx, options.actor, 'games.stat.updated', 'stat', current.id);
    const row = await trx
      .selectFrom('stat_definitions')
      .selectAll()
      .where('id', '=', current.id)
      .executeTakeFirstOrThrow();
    return { status: 'ok', stat: statRecord(row) };
  });
}

export async function deleteStat(
  db: Kysely<Database>,
  options: { gameId: string; key: string; actor: EventActor },
): Promise<{ status: 'ok' } | { status: 'not_found' }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('stat_definitions')
      .select(['id'])
      .where('game_id', '=', options.gameId)
      .where('key', '=', options.key)
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    await writeAudit(trx, options.actor, 'games.stat.deleted', 'stat', current.id);
    await trx.deleteFrom('stat_definitions').where('id', '=', current.id).execute();
    return { status: 'ok' };
  });
}

export async function recordStatValue(
  db: Kysely<Database>,
  options: {
    gameId: string;
    key: string;
    userId: string;
    value: number;
    trust: GameTrustLevel;
    hiddenByDefault: boolean;
    actor: EventActor;
    now: Date;
  },
): Promise<StatUpdateOutcome> {
  if (!Number.isFinite(options.value)) return { status: 'authority_mismatch' };
  return db.transaction().execute(async (trx) => {
    const statRow = await trx
      .selectFrom('stat_definitions')
      .selectAll()
      .where('game_id', '=', options.gameId)
      .where('key', '=', options.key)
      .executeTakeFirst();
    if (!statRow) return { status: 'not_found' };
    const stat = statRecord(statRow);
    if (stat.authority === 'game' && options.trust !== 'game') {
      return { status: 'authority_mismatch' };
    }
    const existing = await trx
      .selectFrom('stat_values')
      .selectAll()
      .where('stat_id', '=', stat.id)
      .where('user_id', '=', options.userId)
      .executeTakeFirst();
    const current = existing ? existing.value : 0;
    const next = aggregateStat(stat.aggregation, current, options.value);
    if (stat.max_delta_per_update !== null) {
      const delta = Math.abs(next - current);
      if (delta > stat.max_delta_per_update) return { status: 'delta_too_large' };
    }
    if (existing && next === current) {
      return {
        status: 'ok' as const,
        stat,
        value: valueRecord(existing),
        changed: false,
      };
    }
    const upserted = existing
      ? await trx
          .updateTable('stat_values')
          .set({ value: next, updates: existing.updates + 1, updated_at: options.now })
          .where('stat_id', '=', stat.id)
          .where('user_id', '=', options.userId)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('stat_values')
          .values({
            stat_id: stat.id,
            user_id: options.userId,
            value: next,
            updates: 1,
            created_at: options.now,
            updated_at: options.now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
    const record = valueRecord(upserted);
    const data: StatUpdatedData = {
      stat_id: stat.id,
      user_id: options.userId,
      game_id: stat.game_id,
      stat_key: stat.key,
      trust: options.trust,
      authority: stat.authority,
      value: record.value,
      updated_at: options.now.toISOString(),
    };
    await writeEvent<Database, StatUpdatedData>(trx, statUpdatedEvent(data, options.actor));
    await updateLeaderboardsForStat(trx, {
      stat,
      userId: options.userId,
      score: record.value,
      now: options.now,
      hidden: options.hiddenByDefault,
    });
    return { status: 'ok' as const, stat, value: record, changed: true };
  });
}

async function updateLeaderboardsForStat(
  db: Kysely<Database>,
  options: {
    stat: StatDefinitionRecord;
    userId: string;
    score: number;
    now: Date;
    hidden: boolean;
  },
): Promise<void> {
  const boards = await db
    .selectFrom('leaderboards')
    .selectAll()
    .where('stat_id', '=', options.stat.id)
    .execute();
  if (boards.length === 0) return;
  const visibility = await db
    .selectFrom('leaderboard_entries')
    .select(['leaderboard_id', 'hidden'])
    .where('user_id', '=', options.userId)
    .where(
      'leaderboard_id',
      'in',
      boards.map((row) => row.id),
    )
    .execute();
  const hiddenBoards = new Map(visibility.map((row) => [row.leaderboard_id, row.hidden]));
  for (const board of boards) {
    const rolled = await rolloverIfDue(db, leaderboardRecord(board), options.now);
    const hidden = hiddenBoards.get(board.id) ?? options.hidden;
    await db
      .insertInto('leaderboard_entries')
      .values({
        leaderboard_id: rolled.id,
        period_started_at: rolled.period_started_at,
        user_id: options.userId,
        score: options.score,
        hidden,
        removed_at: null,
        removed_reason: null,
        updated_at: options.now,
      })
      .onConflict((oc) =>
        oc.columns(['leaderboard_id', 'period_started_at', 'user_id']).doUpdateSet({
          score: options.score,
          hidden,
          removed_at: null,
          removed_reason: null,
          updated_at: options.now,
        }),
      )
      .execute();
  }
}

async function rolloverIfDue(
  db: Kysely<Database>,
  board: LeaderboardRecord,
  now: Date,
): Promise<LeaderboardRecord> {
  if (board.period_ends_at === null || now < board.period_ends_at) return board;
  const bounds = nextPeriod(board.reset_period, board.period_ends_at);
  await db
    .updateTable('leaderboards')
    .set({
      period_started_at: bounds.started_at,
      period_ends_at: bounds.ends_at,
      updated_at: now,
    })
    .where('id', '=', board.id)
    .execute();
  return {
    ...board,
    period_started_at: bounds.started_at,
    period_ends_at: bounds.ends_at,
  };
}

export async function resetDueLeaderboards(
  db: Kysely<Database>,
  now: Date,
): Promise<{ boards: number }> {
  const due = await db
    .selectFrom('leaderboards')
    .selectAll()
    .where('period_ends_at', 'is not', null)
    .where('period_ends_at', '<=', now)
    .execute();
  for (const row of due) await rolloverIfDue(db, leaderboardRecord(row), now);
  return { boards: due.length };
}

export async function listLeaderboards(
  db: Kysely<Database>,
  statId: string,
): Promise<LeaderboardRecord[]> {
  const rows = await db
    .selectFrom('leaderboards')
    .selectAll()
    .where('stat_id', '=', statId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map(leaderboardRecord);
}

export async function listGameLeaderboards(
  db: Kysely<Database>,
  gameId: string,
): Promise<{ leaderboard: LeaderboardRecord; stat: StatDefinitionRecord }[]> {
  const rows = await db
    .selectFrom('leaderboards')
    .innerJoin('stat_definitions', 'stat_definitions.id', 'leaderboards.stat_id')
    .selectAll('leaderboards')
    .select([
      'stat_definitions.id as stat_row_id',
      'stat_definitions.game_id as stat_game_id',
      'stat_definitions.key as stat_key',
      'stat_definitions.type as stat_type',
      'stat_definitions.aggregation as stat_aggregation',
      'stat_definitions.authority as stat_authority',
      'stat_definitions.max_delta_per_update as stat_max_delta_per_update',
      'stat_definitions.created_at as stat_created_at',
      'stat_definitions.updated_at as stat_updated_at',
    ])
    .where('stat_definitions.game_id', '=', gameId)
    .orderBy('leaderboards.created_at', 'asc')
    .execute();
  return rows.map((row) => ({
    leaderboard: leaderboardRecord({
      id: row.id,
      stat_id: row.stat_id,
      slug: row.slug,
      name: row.name,
      sort: row.sort,
      reset_period: row.reset_period,
      period_started_at: row.period_started_at,
      period_ends_at: row.period_ends_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }),
    stat: statRecord({
      id: row.stat_row_id,
      game_id: row.stat_game_id,
      key: row.stat_key,
      type: row.stat_type,
      aggregation: row.stat_aggregation,
      authority: row.stat_authority,
      max_delta_per_update: row.stat_max_delta_per_update,
      created_at: row.stat_created_at,
      updated_at: row.stat_updated_at,
    }),
  }));
}

export async function getLeaderboardBySlug(
  db: Kysely<Database>,
  options: { gameId: string; statKey: string; slug: string },
): Promise<{ leaderboard: LeaderboardRecord; stat: StatDefinitionRecord } | undefined> {
  const row = await db
    .selectFrom('leaderboards')
    .innerJoin('stat_definitions', 'stat_definitions.id', 'leaderboards.stat_id')
    .selectAll('leaderboards')
    .select([
      'stat_definitions.id as stat_row_id',
      'stat_definitions.game_id as stat_game_id',
      'stat_definitions.key as stat_key',
      'stat_definitions.type as stat_type',
      'stat_definitions.aggregation as stat_aggregation',
      'stat_definitions.authority as stat_authority',
      'stat_definitions.max_delta_per_update as stat_max_delta_per_update',
      'stat_definitions.created_at as stat_created_at',
      'stat_definitions.updated_at as stat_updated_at',
    ])
    .where('stat_definitions.game_id', '=', options.gameId)
    .where('stat_definitions.key', '=', options.statKey)
    .where('leaderboards.slug', '=', options.slug)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    leaderboard: leaderboardRecord({
      id: row.id,
      stat_id: row.stat_id,
      slug: row.slug,
      name: row.name,
      sort: row.sort,
      reset_period: row.reset_period,
      period_started_at: row.period_started_at,
      period_ends_at: row.period_ends_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }),
    stat: statRecord({
      id: row.stat_row_id,
      game_id: row.stat_game_id,
      key: row.stat_key,
      type: row.stat_type,
      aggregation: row.stat_aggregation,
      authority: row.stat_authority,
      max_delta_per_update: row.stat_max_delta_per_update,
      created_at: row.stat_created_at,
      updated_at: row.stat_updated_at,
    }),
  };
}

export async function createLeaderboard(
  db: Kysely<Database>,
  options: {
    gameId: string;
    statKey: string;
    slug: string;
    name: string;
    sort: LeaderboardSort;
    reset_period: LeaderboardResetPeriod;
    requireGameAuthority: boolean;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; leaderboard: LeaderboardRecord } | { status: LeaderboardWriteError }> {
  const name = trimmed(options.name, GAME_LEADERBOARD_NAME_MAX);
  const slug = trimmed(options.slug, 80);
  if (name === undefined || slug === undefined) return { status: 'invalid' };
  return db.transaction().execute(async (trx) => {
    const stat = await trx
      .selectFrom('stat_definitions')
      .selectAll()
      .where('game_id', '=', options.gameId)
      .where('key', '=', options.statKey)
      .executeTakeFirst();
    if (!stat) return { status: 'not_found' };
    if (options.requireGameAuthority && stat.authority !== 'game') {
      return { status: 'needs_game_authority' };
    }
    if (await leaderboardSlugTaken(trx, stat.id, slug)) return { status: 'slug_taken' };
    const bounds = periodBounds(options.reset_period, options.now);
    const row = await trx
      .insertInto('leaderboards')
      .values({
        id: randomUUID(),
        stat_id: stat.id,
        slug,
        name,
        sort: options.sort,
        reset_period: options.reset_period,
        period_started_at: bounds.started_at,
        period_ends_at: bounds.ends_at,
        created_at: options.now,
        updated_at: options.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, options.actor, 'games.leaderboard.created', 'leaderboard', row.id);
    return { status: 'ok', leaderboard: leaderboardRecord(row) };
  });
}

export async function updateLeaderboard(
  db: Kysely<Database>,
  options: LeaderboardFields & {
    leaderboardId: string;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; leaderboard: LeaderboardRecord } | { status: LeaderboardWriteError }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('leaderboards')
      .selectAll()
      .where('id', '=', options.leaderboardId)
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    const patch: Partial<Selectable<LeaderboardsTable>> = { updated_at: options.now };
    if (options.slug !== undefined && options.slug !== current.slug) {
      const slug = trimmed(options.slug, 80);
      if (slug === undefined) return { status: 'invalid' };
      if (await leaderboardSlugTaken(trx, current.stat_id, slug, current.id)) {
        return { status: 'slug_taken' };
      }
      patch.slug = slug;
    }
    if (options.name !== undefined) {
      const name = trimmed(options.name, GAME_LEADERBOARD_NAME_MAX);
      if (name === undefined) return { status: 'invalid' };
      patch.name = name;
    }
    if (options.sort !== undefined) patch.sort = options.sort;
    if (options.reset_period !== undefined && options.reset_period !== current.reset_period) {
      const bounds = periodBounds(options.reset_period, options.now);
      patch.reset_period = options.reset_period;
      patch.period_started_at = bounds.started_at;
      patch.period_ends_at = bounds.ends_at;
    }
    await trx.updateTable('leaderboards').set(patch).where('id', '=', current.id).execute();
    await writeAudit(trx, options.actor, 'games.leaderboard.updated', 'leaderboard', current.id);
    const row = await trx
      .selectFrom('leaderboards')
      .selectAll()
      .where('id', '=', current.id)
      .executeTakeFirstOrThrow();
    return { status: 'ok', leaderboard: leaderboardRecord(row) };
  });
}

export async function deleteLeaderboard(
  db: Kysely<Database>,
  options: { leaderboardId: string; actor: EventActor },
): Promise<{ status: 'ok' } | { status: 'not_found' }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('leaderboards')
      .select(['id'])
      .where('id', '=', options.leaderboardId)
      .executeTakeFirst();
    if (!current) return { status: 'not_found' };
    await writeAudit(trx, options.actor, 'games.leaderboard.deleted', 'leaderboard', current.id);
    await trx.deleteFrom('leaderboards').where('id', '=', current.id).execute();
    return { status: 'ok' };
  });
}

export interface LeaderboardPageEntry {
  rank: number;
  user_id: string;
  score: number;
  hidden: boolean;
}

export async function readLeaderboard(
  db: Kysely<Database>,
  options: {
    leaderboardId: string;
    period_started_at: Date;
    sort: LeaderboardSort;
    limit: number;
  },
): Promise<LeaderboardPageEntry[]> {
  const rows = await db
    .selectFrom('leaderboard_entries')
    .select(['user_id', 'score', 'hidden'])
    .where('leaderboard_id', '=', options.leaderboardId)
    .where('period_started_at', '=', options.period_started_at)
    .where('removed_at', 'is', null)
    .orderBy('score', options.sort === 'asc' ? 'asc' : 'desc')
    .orderBy('updated_at', 'asc')
    .limit(options.limit)
    .execute();
  return rows.map((row, index) => ({
    rank: index + 1,
    user_id: row.user_id,
    score: row.score,
    hidden: row.hidden,
  }));
}

export async function setLeaderboardVisibility(
  db: Kysely<Database>,
  options: {
    leaderboardId: string;
    period_started_at: Date;
    userId: string;
    hidden: boolean;
    now: Date;
  },
): Promise<{ status: 'ok'; entry: LeaderboardEntryRecord } | { status: 'not_found' }> {
  const result = await db
    .updateTable('leaderboard_entries')
    .set({ hidden: options.hidden, updated_at: options.now })
    .where('leaderboard_id', '=', options.leaderboardId)
    .where('period_started_at', '=', options.period_started_at)
    .where('user_id', '=', options.userId)
    .where('removed_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  if (!result) return { status: 'not_found' };
  return { status: 'ok', entry: leaderboardEntryRecord(result) };
}

export async function removeLeaderboardEntry(
  db: Kysely<Database>,
  options: {
    leaderboardId: string;
    period_started_at: Date;
    userId: string;
    reason: string;
    actor: EventActor;
    now: Date;
  },
): Promise<
  | { status: 'ok'; entry: LeaderboardEntryRecord; leaderboard: LeaderboardRecord }
  | { status: 'not_found' }
> {
  return db.transaction().execute(async (trx) => {
    const board = await trx
      .selectFrom('leaderboards')
      .innerJoin('stat_definitions', 'stat_definitions.id', 'leaderboards.stat_id')
      .selectAll('leaderboards')
      .select(['stat_definitions.game_id as game_id', 'stat_definitions.key as stat_key'])
      .where('leaderboards.id', '=', options.leaderboardId)
      .executeTakeFirst();
    if (!board) return { status: 'not_found' as const };
    const result = await trx
      .updateTable('leaderboard_entries')
      .set({
        removed_at: options.now,
        removed_reason: options.reason,
        updated_at: options.now,
      })
      .where('leaderboard_id', '=', options.leaderboardId)
      .where('period_started_at', '=', options.period_started_at)
      .where('user_id', '=', options.userId)
      .where('removed_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    if (!result) return { status: 'not_found' as const };
    const entry = leaderboardEntryRecord(result);
    const data: LeaderboardEntryRemovedData = {
      leaderboard_id: board.id,
      stat_id: board.stat_id,
      user_id: options.userId,
      game_id: board.game_id,
      leaderboard_slug: board.slug,
      period_started_at: options.period_started_at.toISOString(),
      reason: options.reason,
    };
    await writeEvent<Database, LeaderboardEntryRemovedData>(
      trx,
      leaderboardEntryRemovedEvent(data, options.actor),
    );
    await writeAudit(
      trx,
      options.actor,
      'games.leaderboard.entry_removed',
      'leaderboard_entry',
      `${board.id}:${options.period_started_at.toISOString()}:${options.userId}`,
    );
    return {
      status: 'ok' as const,
      entry,
      leaderboard: leaderboardRecord({
        id: board.id,
        stat_id: board.stat_id,
        slug: board.slug,
        name: board.name,
        sort: board.sort,
        reset_period: board.reset_period,
        period_started_at: board.period_started_at,
        period_ends_at: board.period_ends_at,
        created_at: board.created_at,
        updated_at: board.updated_at,
      }),
    };
  });
}

export async function getCustomData(
  db: Kysely<Database>,
  gameId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  const row = await db
    .selectFrom('stat_custom_data')
    .select(['data'])
    .where('game_id', '=', gameId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.data ?? {};
}

export async function writeCustomData(
  db: Kysely<Database>,
  options: { gameId: string; userId: string; data: Record<string, unknown>; now: Date },
): Promise<CustomDataWriteOutcome> {
  if (customDataSize(options.data) > GAME_CUSTOM_DATA_MAX_BYTES) return { status: 'too_large' };
  await db
    .insertInto('stat_custom_data')
    .values({
      game_id: options.gameId,
      user_id: options.userId,
      data: options.data,
      updated_at: options.now,
    })
    .onConflict((oc) =>
      oc.columns(['game_id', 'user_id']).doUpdateSet({
        data: options.data,
        updated_at: options.now,
      }),
    )
    .execute();
  return { status: 'ok', data: options.data };
}

async function accumulateDaily(
  db: Kysely<Database>,
  options: { userId: string; gameId: string; seconds: number; day: Date; now: Date },
): Promise<void> {
  if (options.seconds <= 0) return;
  await db
    .insertInto('playtime_daily')
    .values({
      user_id: options.userId,
      game_id: options.gameId,
      day: options.day,
      seconds: options.seconds,
      updated_at: options.now,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'game_id', 'day']).doUpdateSet((eb) => ({
        seconds: eb('playtime_daily.seconds', '+', options.seconds),
        updated_at: options.now,
      })),
    )
    .execute();
}

export async function dailyPlaytimeSeconds(
  db: Kysely<Database>,
  options: { userId: string; gameId: string; day: Date },
): Promise<number> {
  const row = await db
    .selectFrom('playtime_daily')
    .select(['seconds'])
    .where('user_id', '=', options.userId)
    .where('game_id', '=', options.gameId)
    .where('day', '=', options.day)
    .executeTakeFirst();
  return row?.seconds ?? 0;
}

export async function startPlaytimeSession(
  db: Kysely<Database>,
  options: {
    gameId: string;
    userId: string;
    dailyLimitMinutes: number | null;
    now: Date;
  },
): Promise<
  | { status: 'ok'; session: PlaytimeSessionRecord; remaining_seconds: number | null }
  | { status: 'limit_reached' }
> {
  return db.transaction().execute(async (trx) => {
    const day = dayStart(options.now);
    const used = await dailyPlaytimeSeconds(trx, {
      userId: options.userId,
      gameId: options.gameId,
      day,
    });
    const limitSeconds = options.dailyLimitMinutes === null ? null : options.dailyLimitMinutes * 60;
    if (limitSeconds !== null && used >= limitSeconds) return { status: 'limit_reached' as const };
    await trx
      .updateTable('playtime_sessions')
      .set({ ended_at: options.now })
      .where('user_id', '=', options.userId)
      .where('game_id', '=', options.gameId)
      .where('ended_at', 'is', null)
      .execute();
    const row = await trx
      .insertInto('playtime_sessions')
      .values({
        id: randomUUID(),
        user_id: options.userId,
        game_id: options.gameId,
        started_at: options.now,
        last_heartbeat_at: options.now,
        ended_at: null,
        duration_seconds: 0,
        created_at: options.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const remaining = limitSeconds === null ? null : Math.max(0, limitSeconds - used);
    return {
      status: 'ok' as const,
      session: playtimeSessionRecord(row),
      remaining_seconds: remaining,
    };
  });
}

export async function heartbeatPlaytimeSession(
  db: Kysely<Database>,
  options: {
    sessionId: string;
    userId: string;
    gameId: string;
    now: Date;
  },
): Promise<{ status: 'ok'; session: PlaytimeSessionRecord } | { status: 'not_found' }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('playtime_sessions')
      .selectAll()
      .where('id', '=', options.sessionId)
      .where('user_id', '=', options.userId)
      .where('game_id', '=', options.gameId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    if (!current) return { status: 'not_found' as const };
    const previous = current.last_heartbeat_at;
    const delta = Math.max(0, Math.floor((options.now.getTime() - previous.getTime()) / 1000));
    const result = await trx
      .updateTable('playtime_sessions')
      .set({
        last_heartbeat_at: options.now,
        duration_seconds: current.duration_seconds + delta,
      })
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (delta > 0) {
      await accumulateDaily(trx, {
        userId: options.userId,
        gameId: options.gameId,
        seconds: delta,
        day: dayStart(previous),
        now: options.now,
      });
    }
    return { status: 'ok' as const, session: playtimeSessionRecord(result) };
  });
}

export async function endPlaytimeSession(
  db: Kysely<Database>,
  options: {
    sessionId: string;
    userId: string;
    gameId: string;
    actor: EventActor;
    now: Date;
  },
): Promise<{ status: 'ok'; session: PlaytimeSessionRecord } | { status: 'not_found' }> {
  return db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('playtime_sessions')
      .selectAll()
      .where('id', '=', options.sessionId)
      .where('user_id', '=', options.userId)
      .where('game_id', '=', options.gameId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    if (!current) return { status: 'not_found' as const };
    const previous = current.last_heartbeat_at;
    const delta = Math.max(0, Math.floor((options.now.getTime() - previous.getTime()) / 1000));
    const duration = current.duration_seconds + delta;
    const result = await trx
      .updateTable('playtime_sessions')
      .set({
        ended_at: options.now,
        last_heartbeat_at: options.now,
        duration_seconds: duration,
      })
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (delta > 0) {
      await accumulateDaily(trx, {
        userId: options.userId,
        gameId: options.gameId,
        seconds: delta,
        day: dayStart(previous),
        now: options.now,
      });
    }
    const data: PlaytimeEndedData = {
      session_id: current.id,
      user_id: options.userId,
      game_id: options.gameId,
      started_at: current.started_at.toISOString(),
      ended_at: options.now.toISOString(),
      duration_seconds: duration,
    };
    await writeEvent<Database, PlaytimeEndedData>(trx, playtimeEndedEvent(data, options.actor));
    return { status: 'ok' as const, session: playtimeSessionRecord(result) };
  });
}

export async function closeStalePlaytimeSessions(
  db: Kysely<Database>,
  options: { staleAfterSeconds: number; now: Date },
): Promise<{ closed: number }> {
  const threshold = new Date(options.now.getTime() - options.staleAfterSeconds * 1000);
  const stale = await db
    .selectFrom('playtime_sessions')
    .selectAll()
    .where('ended_at', 'is', null)
    .where('last_heartbeat_at', '<', threshold)
    .execute();
  for (const row of stale) {
    const result = await db
      .updateTable('playtime_sessions')
      .set({ ended_at: row.last_heartbeat_at })
      .where('id', '=', row.id)
      .where('ended_at', 'is', null)
      .executeTakeFirst();
    if (updatedRows(result) !== 1) continue;
    const data: PlaytimeEndedData = {
      session_id: row.id,
      user_id: row.user_id,
      game_id: row.game_id,
      started_at: row.started_at.toISOString(),
      ended_at: row.last_heartbeat_at.toISOString(),
      duration_seconds: row.duration_seconds,
    };
    await writeEvent<Database, PlaytimeEndedData>(
      db,
      playtimeEndedEvent(data, { type: 'system', id: 'games' }),
    );
  }
  return { closed: stale.length };
}

export async function remainingPlaytimeSeconds(
  db: Kysely<Database>,
  options: { userId: string; gameId: string; dailyLimitMinutes: number | null; now: Date },
): Promise<{ remaining_seconds: number | null; used_seconds: number }> {
  const day = dayStart(options.now);
  const used = await dailyPlaytimeSeconds(db, {
    userId: options.userId,
    gameId: options.gameId,
    day,
  });
  if (options.dailyLimitMinutes === null) {
    return { remaining_seconds: null, used_seconds: used };
  }
  const limitSeconds = options.dailyLimitMinutes * 60;
  return {
    remaining_seconds: Math.max(0, limitSeconds - used),
    used_seconds: used,
  };
}

export async function exportUserStats(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('stat_values')
    .innerJoin('stat_definitions', 'stat_definitions.id', 'stat_values.stat_id')
    .innerJoin('games', 'games.id', 'stat_definitions.game_id')
    .select([
      'games.slug as game_slug',
      'stat_definitions.key as stat_key',
      'stat_values.value as value',
      'stat_values.updates as updates',
      'stat_values.updated_at as updated_at',
    ])
    .where('stat_values.user_id', '=', userId)
    .orderBy('stat_values.updated_at', 'desc')
    .execute();
  return rows.map((row) => ({
    game_slug: row.game_slug,
    stat_key: row.stat_key,
    value: row.value,
    updates: row.updates,
    updated_at: row.updated_at.toISOString(),
  }));
}

export async function exportUserCustomData(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('stat_custom_data')
    .innerJoin('games', 'games.id', 'stat_custom_data.game_id')
    .select(['games.slug as game_slug', 'stat_custom_data.data as data'])
    .where('stat_custom_data.user_id', '=', userId)
    .execute();
  return rows.map((row) => ({ game_slug: row.game_slug, data: row.data }));
}

export async function exportUserPlaytime(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('playtime_daily')
    .innerJoin('games', 'games.id', 'playtime_daily.game_id')
    .select(['games.slug as game_slug', 'playtime_daily.day as day', 'playtime_daily.seconds'])
    .where('playtime_daily.user_id', '=', userId)
    .orderBy('playtime_daily.day', 'desc')
    .execute();
  return rows.map((row) => ({
    game_slug: row.game_slug,
    day: row.day.toISOString().slice(0, 10),
    seconds: row.seconds,
  }));
}

export async function eraseUserStats(db: Kysely<Database>, userId: string): Promise<void> {
  await db.deleteFrom('stat_values').where('user_id', '=', userId).execute();
  await db.deleteFrom('stat_custom_data').where('user_id', '=', userId).execute();
  await db.deleteFrom('leaderboard_entries').where('user_id', '=', userId).execute();
  await db.deleteFrom('playtime_sessions').where('user_id', '=', userId).execute();
  await db.deleteFrom('playtime_daily').where('user_id', '=', userId).execute();
}
