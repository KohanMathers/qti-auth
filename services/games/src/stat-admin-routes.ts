import { GAME_REVOKE_REASON_MAX, GAME_SLUG, GAME_SLUG_MESSAGE } from '@qtiauth/config';
import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { getGameBySlug } from './catalog.ts';
import type { LeaderboardResetPeriod } from './database.ts';
import { gamesMetrics } from './metrics.ts';
import { signedIn } from './routes.ts';
import type { Context } from './service.ts';
import {
  createLeaderboard,
  createStat,
  deleteLeaderboard,
  deleteStat,
  GAME_LEADERBOARD_NAME_MAX,
  type LeaderboardRecord,
  listGameLeaderboards,
  listStats,
  removeLeaderboardEntry,
  type StatDefinitionRecord,
  updateLeaderboard,
  updateStat,
} from './stats.ts';

const statKey = z.string().min(1).max(80).regex(GAME_SLUG, GAME_SLUG_MESSAGE);
const leaderboardSlug = z.string().min(1).max(80).regex(GAME_SLUG, GAME_SLUG_MESSAGE);
const resetPeriod = z
  .string()
  .min(1)
  .max(80)
  .refine(
    (value) =>
      value === 'never' ||
      value === 'daily' ||
      value === 'weekly' ||
      value === 'monthly' ||
      /^season:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value),
    'Must be never, daily, weekly, monthly, or season:<slug>',
  );

const statCreateBody = z.object({
  key: statKey,
  type: z.enum(['int', 'float', 'duration']),
  aggregation: z.enum(['sum', 'max', 'min', 'latest']),
  authority: z.enum(['player', 'game']).default('player'),
  max_delta_per_update: z.number().positive().nullable().default(null),
});

const statPatchBody = z.object({
  key: statKey.optional(),
  type: z.enum(['int', 'float', 'duration']).optional(),
  aggregation: z.enum(['sum', 'max', 'min', 'latest']).optional(),
  authority: z.enum(['player', 'game']).optional(),
  max_delta_per_update: z.number().positive().nullable().optional(),
});

const leaderboardCreateBody = z.object({
  stat_key: statKey,
  slug: leaderboardSlug,
  name: z.string().min(1).max(GAME_LEADERBOARD_NAME_MAX),
  sort: z.enum(['asc', 'desc']).default('desc'),
  reset_period: resetPeriod.default('never'),
});

const leaderboardPatchBody = z.object({
  slug: leaderboardSlug.optional(),
  name: z.string().min(1).max(GAME_LEADERBOARD_NAME_MAX).optional(),
  sort: z.enum(['asc', 'desc']).optional(),
  reset_period: resetPeriod.optional(),
});

const removeEntryBody = z.object({
  reason: z.string().trim().min(1).max(GAME_REVOKE_REASON_MAX),
});

const statSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  type: z.enum(['int', 'float', 'duration']),
  aggregation: z.enum(['sum', 'max', 'min', 'latest']),
  authority: z.enum(['player', 'game']),
  max_delta_per_update: z.number().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const leaderboardSchema = z.object({
  id: z.uuid(),
  stat_key: z.string(),
  slug: z.string(),
  name: z.string(),
  sort: z.enum(['asc', 'desc']),
  reset_period: z.string(),
  period_started_at: z.iso.datetime(),
  period_ends_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const removeEntryResponseSchema = z.object({
  leaderboard_id: z.uuid(),
  leaderboard_slug: z.string(),
  user_id: z.uuid(),
  period_started_at: z.iso.datetime(),
  removed_at: z.iso.datetime(),
  reason: z.string(),
});

function statView(record: StatDefinitionRecord) {
  return {
    id: record.id,
    key: record.key,
    type: record.type,
    aggregation: record.aggregation,
    authority: record.authority,
    max_delta_per_update: record.max_delta_per_update,
    created_at: record.created_at.toISOString(),
    updated_at: record.updated_at.toISOString(),
  };
}

function leaderboardView(board: LeaderboardRecord, statKeyValue: string) {
  return {
    id: board.id,
    stat_key: statKeyValue,
    slug: board.slug,
    name: board.name,
    sort: board.sort,
    reset_period: board.reset_period,
    period_started_at: board.period_started_at.toISOString(),
    period_ends_at: board.period_ends_at?.toISOString() ?? null,
    created_at: board.created_at.toISOString(),
    updated_at: board.updated_at.toISOString(),
  };
}

async function requireGame(ctx: Context, slug: string) {
  const game = await getGameBySlug(ctx.db, slug);
  if (!game) throw new ProblemError('GAMES_NOT_FOUND');
  return game;
}

function statError(status: string): never {
  if (status === 'not_found') throw new ProblemError('GAMES_STAT_NOT_FOUND');
  if (status === 'key_taken') throw new ProblemError('GAMES_STAT_KEY_TAKEN');
  throw new ProblemError('GAMES_STAT_INVALID');
}

function leaderboardError(status: string): never {
  if (status === 'not_found') throw new ProblemError('GAMES_STAT_NOT_FOUND');
  if (status === 'slug_taken') throw new ProblemError('GAMES_LEADERBOARD_SLUG_TAKEN');
  if (status === 'needs_game_authority') {
    throw new ProblemError('GAMES_LEADERBOARD_REQUIRES_GAME_AUTHORITY');
  }
  throw new ProblemError('GAMES_STAT_INVALID');
}

export function statAdminRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/games/:slug/stats',
    operation_id: 'listAdminStats',
    summary: 'Stat definitions for a game',
    tags: ['games', 'stats', 'admin'],
    auth: 'session',
    permissions: ['games.stats.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: {
      200: {
        description: 'Stat definitions',
        schema: z.object({ items: z.array(statSchema) }),
      },
    },
    errors: ['GAMES_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const game = await requireGame(ctx, params.slug);
      const rows = await listStats(ctx.db, game.id);
      return { status: 200 as const, body: { items: rows.map(statView) } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/games/:slug/stats',
    operation_id: 'createAdminStat',
    summary: 'Create a stat definition',
    tags: ['games', 'stats', 'admin'],
    auth: 'session',
    permissions: ['games.stats.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }), body: statCreateBody },
    responses: { 201: { description: 'The stat', schema: statSchema } },
    errors: ['GAMES_NOT_FOUND', 'GAMES_STAT_KEY_TAKEN', 'GAMES_STAT_INVALID'],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const result = await createStat(ctx.db, {
        gameId: game.id,
        key: body.key,
        type: body.type,
        aggregation: body.aggregation,
        authority: body.authority,
        max_delta_per_update: body.max_delta_per_update,
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status !== 'ok') statError(result.status);
      ctx.outbox.wake();
      return { status: 201 as const, body: statView(result.stat) };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/admin/games/:slug/stats/:key',
    operation_id: 'updateAdminStat',
    summary: 'Update a stat definition',
    tags: ['games', 'stats', 'admin'],
    auth: 'session',
    permissions: ['games.stats.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), key: z.string().min(1) }),
      body: statPatchBody,
    },
    responses: { 200: { description: 'The stat', schema: statSchema } },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_STAT_NOT_FOUND',
      'GAMES_STAT_KEY_TAKEN',
      'GAMES_STAT_INVALID',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const result = await updateStat(ctx.db, {
        gameId: game.id,
        currentKey: params.key,
        ...(body.key === undefined ? {} : { key: body.key }),
        ...(body.type === undefined ? {} : { type: body.type }),
        ...(body.aggregation === undefined ? {} : { aggregation: body.aggregation }),
        ...(body.authority === undefined ? {} : { authority: body.authority }),
        ...(body.max_delta_per_update === undefined
          ? {}
          : { max_delta_per_update: body.max_delta_per_update }),
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status !== 'ok') statError(result.status);
      ctx.outbox.wake();
      return { status: 200 as const, body: statView(result.stat) };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/games/:slug/stats/:key',
    operation_id: 'deleteAdminStat',
    summary: 'Delete a stat definition and every value stored against it',
    tags: ['games', 'stats', 'admin'],
    auth: 'session',
    permissions: ['games.stats.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1), key: z.string().min(1) }) },
    responses: { 204: { description: 'Deleted' } },
    errors: ['GAMES_NOT_FOUND', 'GAMES_STAT_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const result = await deleteStat(ctx.db, {
        gameId: game.id,
        key: params.key,
        actor: { type: 'user', id: actorId },
      });
      if (result.status !== 'ok') throw new ProblemError('GAMES_STAT_NOT_FOUND');
      ctx.outbox.wake();
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/games/:slug/leaderboards',
    operation_id: 'listAdminLeaderboards',
    summary: 'Leaderboards for a game',
    tags: ['games', 'stats', 'admin'],
    auth: 'session',
    permissions: ['games.stats.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: {
      200: {
        description: 'Leaderboards',
        schema: z.object({ items: z.array(leaderboardSchema) }),
      },
    },
    errors: ['GAMES_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const game = await requireGame(ctx, params.slug);
      const rows = await listGameLeaderboards(ctx.db, game.id);
      return {
        status: 200 as const,
        body: { items: rows.map((row) => leaderboardView(row.leaderboard, row.stat.key)) },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/games/:slug/leaderboards',
    operation_id: 'createAdminLeaderboard',
    summary: 'Create a leaderboard',
    tags: ['games', 'stats', 'admin'],
    auth: 'session',
    permissions: ['games.stats.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }), body: leaderboardCreateBody },
    responses: { 201: { description: 'The leaderboard', schema: leaderboardSchema } },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_STAT_NOT_FOUND',
      'GAMES_LEADERBOARD_SLUG_TAKEN',
      'GAMES_LEADERBOARD_REQUIRES_GAME_AUTHORITY',
      'GAMES_STAT_INVALID',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const requireGameAuthority = ctx.config.features.games.leaderboards.require_game_authority;
      const result = await createLeaderboard(ctx.db, {
        gameId: game.id,
        statKey: body.stat_key,
        slug: body.slug,
        name: body.name,
        sort: body.sort,
        reset_period: body.reset_period as LeaderboardResetPeriod,
        requireGameAuthority,
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status !== 'ok') leaderboardError(result.status);
      ctx.outbox.wake();
      return { status: 201 as const, body: leaderboardView(result.leaderboard, body.stat_key) };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/admin/leaderboards/:leaderboard_id',
    operation_id: 'updateAdminLeaderboard',
    summary: 'Update a leaderboard',
    tags: ['games', 'stats', 'admin'],
    auth: 'session',
    permissions: ['games.stats.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ leaderboard_id: z.uuid() }),
      body: leaderboardPatchBody,
    },
    responses: { 200: { description: 'The leaderboard', schema: leaderboardSchema } },
    errors: ['GAMES_STAT_NOT_FOUND', 'GAMES_LEADERBOARD_SLUG_TAKEN', 'GAMES_STAT_INVALID'],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const result = await updateLeaderboard(ctx.db, {
        leaderboardId: params.leaderboard_id,
        ...(body.slug === undefined ? {} : { slug: body.slug }),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.sort === undefined ? {} : { sort: body.sort }),
        ...(body.reset_period === undefined
          ? {}
          : { reset_period: body.reset_period as LeaderboardResetPeriod }),
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status !== 'ok') leaderboardError(result.status);
      const statRow = await ctx.db
        .selectFrom('stat_definitions')
        .select(['key'])
        .where('id', '=', result.leaderboard.stat_id)
        .executeTakeFirstOrThrow();
      ctx.outbox.wake();
      return {
        status: 200 as const,
        body: leaderboardView(result.leaderboard, statRow.key),
      };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/leaderboards/:leaderboard_id',
    operation_id: 'deleteAdminLeaderboard',
    summary: 'Delete a leaderboard and every entry',
    tags: ['games', 'stats', 'admin'],
    auth: 'session',
    permissions: ['games.stats.manage'],
    rate_limit: 'global',
    request: { params: z.object({ leaderboard_id: z.uuid() }) },
    responses: { 204: { description: 'Deleted' } },
    errors: ['GAMES_LEADERBOARD_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const actorId = signedIn(identity);
      const result = await deleteLeaderboard(ctx.db, {
        leaderboardId: params.leaderboard_id,
        actor: { type: 'user', id: actorId },
      });
      if (result.status !== 'ok') throw new ProblemError('GAMES_LEADERBOARD_NOT_FOUND');
      ctx.outbox.wake();
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/leaderboards/:leaderboard_id/entries/:user_id/remove',
    operation_id: 'removeAdminLeaderboardEntry',
    summary: 'Remove a player’s entry from the current period',
    description:
      'Emits qtiauth.games.leaderboard_entry.removed.v1 and writes an audit record. Use for cheating or moderation decisions.',
    tags: ['games', 'stats', 'admin'],
    auth: 'session',
    permissions: ['games.stats.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ leaderboard_id: z.uuid(), user_id: z.uuid() }),
      body: removeEntryBody,
    },
    responses: { 200: { description: 'The removed entry', schema: removeEntryResponseSchema } },
    errors: ['GAMES_LEADERBOARD_NOT_FOUND', 'GAMES_LEADERBOARD_ENTRY_NOT_FOUND'],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const board = await ctx.db
        .selectFrom('leaderboards')
        .select(['id', 'slug', 'period_started_at'])
        .where('id', '=', params.leaderboard_id)
        .executeTakeFirst();
      if (!board) throw new ProblemError('GAMES_LEADERBOARD_NOT_FOUND');
      const now = new Date();
      const result = await removeLeaderboardEntry(ctx.db, {
        leaderboardId: board.id,
        period_started_at: board.period_started_at,
        userId: params.user_id,
        reason: body.reason,
        actor: { type: 'user', id: actorId },
        now,
      });
      if (result.status !== 'ok') throw new ProblemError('GAMES_LEADERBOARD_ENTRY_NOT_FOUND');
      ctx.outbox.wake();
      gamesMetrics(ctx.metrics).leaderboardEntryRemoved();
      return {
        status: 200 as const,
        body: {
          leaderboard_id: board.id,
          leaderboard_slug: board.slug,
          user_id: params.user_id,
          period_started_at: board.period_started_at.toISOString(),
          removed_at: now.toISOString(),
          reason: body.reason,
        },
      };
    },
  });
}
