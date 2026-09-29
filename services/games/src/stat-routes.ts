import { GAME_STATS_WRITE_SCOPE } from '@qtiauth/config';
import type { GameTrustLevel } from '@qtiauth/events';
import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { gamesMetrics } from './metrics.ts';
import { requireGameToken, requirePublicGame } from './route-helpers.ts';
import { signedIn } from './routes.ts';
import type { Context } from './service.ts';
import {
  endPlaytimeSession,
  GAME_CUSTOM_DATA_MAX_BYTES,
  getCustomData,
  getLeaderboardBySlug,
  heartbeatPlaytimeSession,
  HIDDEN_ENTRY_DISPLAY,
  type LeaderboardPageEntry,
  listStats,
  readLeaderboard,
  recordStatValue,
  remainingPlaytimeSeconds,
  setLeaderboardVisibility,
  startPlaytimeSession,
  type StatDefinitionRecord,
  writeCustomData,
} from './stats.ts';

const HEARTBEAT_INTERVAL_MESSAGE = '60';
const CUSTOM_DATA_LIMIT_MESSAGE = String(GAME_CUSTOM_DATA_MAX_BYTES);

const statSchema = z.object({
  key: z.string(),
  type: z.enum(['int', 'float', 'duration']),
  aggregation: z.enum(['sum', 'max', 'min', 'latest']),
  authority: z.enum(['player', 'game']),
  max_delta_per_update: z.number().nullable(),
});

const statValueSchema = z.object({
  key: z.string(),
  value: z.number(),
  authority: z.enum(['player', 'game']),
  updated_at: z.iso.datetime(),
});

const updateStatBody = z.object({
  value: z.number(),
});

const leaderboardEntrySchema = z.object({
  rank: z.int(),
  user_id: z.uuid().nullable(),
  display_name: z.string(),
  score: z.number(),
});

const leaderboardVisibilityBody = z.object({
  hidden: z.boolean(),
});

const customDataBody = z.object({
  data: z.record(z.string(), z.unknown()),
});

const customDataResponseSchema = z.object({
  data: z.record(z.string(), z.unknown()),
});

const playtimeStartResponseSchema = z.object({
  session_id: z.uuid(),
  remaining_seconds: z.int().nullable(),
  daily_limit_minutes: z.int().nullable(),
});

const playtimeHeartbeatResponseSchema = z.object({
  session_id: z.uuid(),
  duration_seconds: z.int(),
});

const playtimeEndResponseSchema = z.object({
  session_id: z.uuid(),
  duration_seconds: z.int(),
});

const playtimeRemainingSchema = z.object({
  remaining_seconds: z.int().nullable(),
  used_seconds: z.int(),
  daily_limit_minutes: z.int().nullable(),
});

function statView(stat: StatDefinitionRecord) {
  return {
    key: stat.key,
    type: stat.type,
    aggregation: stat.aggregation,
    authority: stat.authority,
    max_delta_per_update: stat.max_delta_per_update,
  };
}

function trustLevel(auth: string): GameTrustLevel {
  return auth === 'game_authoritative' ? 'game' : 'player';
}

function hiddenByDefault(identity: { age_band: string | null }): boolean {
  return identity.age_band !== null && identity.age_band !== 'adult';
}

function dailyLimitMinutes(identity: {
  parental_controls: { daily_playtime_minutes: number | null } | null;
}): number | null {
  return identity.parental_controls?.daily_playtime_minutes ?? null;
}

function leaderboardEntryView(
  entry: LeaderboardPageEntry,
  viewerId: string | null,
): z.output<typeof leaderboardEntrySchema> {
  const showUser = !entry.hidden || entry.user_id === viewerId;
  return {
    rank: entry.rank,
    user_id: showUser ? entry.user_id : null,
    display_name: showUser ? entry.user_id : HIDDEN_ENTRY_DISPLAY,
    score: entry.score,
  };
}

function statResponseError(status: string): never {
  if (status === 'not_found') throw new ProblemError('GAMES_STAT_NOT_FOUND');
  if (status === 'authority_mismatch') throw new ProblemError('GAMES_STAT_AUTHORITY_MISMATCH');
  if (status === 'delta_too_large') throw new ProblemError('GAMES_STAT_DELTA_TOO_LARGE');
  throw new ProblemError('GAMES_STAT_INVALID');
}

export function statRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/stats',
    operation_id: 'listGameStats',
    summary: 'Stat definitions for a game',
    tags: ['games', 'stats'],
    auth: 'session',
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
      const game = await requirePublicGame(ctx, params.slug);
      const stats = await listStats(ctx.db, game.id);
      return { status: 200 as const, body: { items: stats.map(statView) } };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/stats/values',
    operation_id: 'listPlayerStats',
    summary: 'The signed-in player’s values for each stat in a game',
    tags: ['games', 'stats'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: {
      200: {
        description: 'Player stat values',
        schema: z.object({ items: z.array(statValueSchema) }),
      },
    },
    errors: ['GAMES_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      const rows = await ctx.db
        .selectFrom('stat_values')
        .innerJoin('stat_definitions', 'stat_definitions.id', 'stat_values.stat_id')
        .select([
          'stat_definitions.key as key',
          'stat_definitions.authority as authority',
          'stat_values.value as value',
          'stat_values.updated_at as updated_at',
        ])
        .where('stat_definitions.game_id', '=', game.id)
        .where('stat_values.user_id', '=', userId)
        .orderBy('stat_definitions.created_at', 'asc')
        .execute();
      return {
        status: 200 as const,
        body: {
          items: rows.map((row) => ({
            key: row.key,
            value: row.value,
            authority: row.authority,
            updated_at: row.updated_at.toISOString(),
          })),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/:slug/stats/:key/update',
    operation_id: 'updateGameStat',
    summary: 'Update a game stat for the player',
    description:
      'Accepted with the player’s access token for the game (trust: player) for player-authority stats, or a game-authoritative write (trust: game) for game-authority stats.',
    tags: ['games', 'stats'],
    auth: 'oauth',
    scopes: [GAME_STATS_WRITE_SCOPE],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), key: z.string().min(1) }),
      body: updateStatBody,
    },
    responses: { 200: { description: 'The stat value', schema: statValueSchema } },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_STAT_NOT_FOUND',
      'GAMES_STAT_INVALID',
      'GAMES_STAT_AUTHORITY_MISMATCH',
      'GAMES_STAT_DELTA_TOO_LARGE',
      'GAMES_WRONG_GAME_TOKEN',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      requireGameToken(identity, game.id);
      const trust = trustLevel(identity.auth);
      const result = await recordStatValue(ctx.db, {
        gameId: game.id,
        key: params.key,
        userId,
        value: body.value,
        trust,
        hiddenByDefault: hiddenByDefault(identity),
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status !== 'ok') statResponseError(result.status);
      if (result.changed) {
        ctx.outbox.wake();
        gamesMetrics(ctx.metrics).statUpdated(trust);
      }
      return {
        status: 200 as const,
        body: {
          key: result.stat.key,
          value: result.value.value,
          authority: result.stat.authority,
          updated_at: result.value.updated_at.toISOString(),
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/custom-data',
    operation_id: 'getPlayerCustomData',
    summary: 'Per-player custom data for a game',
    tags: ['games', 'stats'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: { 200: { description: 'Custom data', schema: customDataResponseSchema } },
    errors: ['GAMES_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      const data = await getCustomData(ctx.db, game.id, userId);
      return { status: 200 as const, body: { data } };
    },
  });

  router.route({
    method: 'PUT',
    path: '/api/v1/games/:slug/custom-data',
    operation_id: 'writePlayerCustomData',
    summary: 'Replace the signed-in player’s custom data for a game',
    description: `Per-player free-form JSON, up to ${CUSTOM_DATA_LIMIT_MESSAGE} bytes.`,
    tags: ['games', 'stats'],
    auth: 'oauth',
    scopes: [GAME_STATS_WRITE_SCOPE],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }), body: customDataBody },
    responses: { 200: { description: 'Stored data', schema: customDataResponseSchema } },
    errors: ['GAMES_NOT_FOUND', 'GAMES_WRONG_GAME_TOKEN', 'GAMES_CUSTOM_DATA_TOO_LARGE'],
    handler: async ({ ctx, identity, params, body }) => {
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      requireGameToken(identity, game.id);
      const result = await writeCustomData(ctx.db, {
        gameId: game.id,
        userId,
        data: body.data,
        now: new Date(),
      });
      if (result.status === 'too_large') throw new ProblemError('GAMES_CUSTOM_DATA_TOO_LARGE');
      return { status: 200 as const, body: { data: result.data } };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/leaderboards/:stat/:board',
    operation_id: 'readLeaderboard',
    summary: 'Read a leaderboard’s current period',
    description:
      'Hidden entries still count in ranking but are shown as “Hidden player” unless they belong to the caller.',
    tags: ['games', 'stats'],
    auth: 'session',
    rate_limit: 'global',
    request: {
      params: z.object({
        slug: z.string().min(1),
        stat: z.string().min(1),
        board: z.string().min(1),
      }),
      query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
    },
    responses: {
      200: {
        description: 'The leaderboard page',
        schema: z.object({
          name: z.string(),
          reset_period: z.string(),
          period_started_at: z.iso.datetime(),
          period_ends_at: z.iso.datetime().nullable(),
          items: z.array(leaderboardEntrySchema),
        }),
      },
    },
    errors: ['GAMES_NOT_FOUND', 'GAMES_LEADERBOARD_NOT_FOUND'],
    handler: async ({ ctx, identity, params, query }) => {
      const game = await requirePublicGame(ctx, params.slug);
      const board = await getLeaderboardBySlug(ctx.db, {
        gameId: game.id,
        statKey: params.stat,
        slug: params.board,
      });
      if (!board) throw new ProblemError('GAMES_LEADERBOARD_NOT_FOUND');
      const entries = await readLeaderboard(ctx.db, {
        leaderboardId: board.leaderboard.id,
        period_started_at: board.leaderboard.period_started_at,
        sort: board.leaderboard.sort,
        limit: query.limit,
      });
      return {
        status: 200 as const,
        body: {
          name: board.leaderboard.name,
          reset_period: board.leaderboard.reset_period,
          period_started_at: board.leaderboard.period_started_at.toISOString(),
          period_ends_at: board.leaderboard.period_ends_at?.toISOString() ?? null,
          items: entries.map((entry) => leaderboardEntryView(entry, identity.sub)),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/:slug/leaderboards/:stat/:board/visibility',
    operation_id: 'setLeaderboardEntryVisibility',
    summary: 'Show or hide the caller’s own leaderboard entry',
    tags: ['games', 'stats'],
    auth: 'session',
    rate_limit: 'global',
    request: {
      params: z.object({
        slug: z.string().min(1),
        stat: z.string().min(1),
        board: z.string().min(1),
      }),
      body: leaderboardVisibilityBody,
    },
    responses: { 204: { description: 'Updated' } },
    errors: ['GAMES_NOT_FOUND', 'GAMES_LEADERBOARD_NOT_FOUND', 'GAMES_LEADERBOARD_ENTRY_NOT_FOUND'],
    handler: async ({ ctx, identity, params, body }) => {
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      const board = await getLeaderboardBySlug(ctx.db, {
        gameId: game.id,
        statKey: params.stat,
        slug: params.board,
      });
      if (!board) throw new ProblemError('GAMES_LEADERBOARD_NOT_FOUND');
      const result = await setLeaderboardVisibility(ctx.db, {
        leaderboardId: board.leaderboard.id,
        period_started_at: board.leaderboard.period_started_at,
        userId,
        hidden: body.hidden,
        now: new Date(),
      });
      if (result.status !== 'ok') throw new ProblemError('GAMES_LEADERBOARD_ENTRY_NOT_FOUND');
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/:slug/playtime/start',
    operation_id: 'startPlaytime',
    summary: 'Open a playtime session',
    description:
      'Trust-based with the player’s access token. Returns the daily-remaining allowance for accounts with parental controls.',
    tags: ['games', 'stats'],
    auth: 'oauth',
    scopes: [GAME_STATS_WRITE_SCOPE],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: { 201: { description: 'The session', schema: playtimeStartResponseSchema } },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_WRONG_GAME_TOKEN',
      'GAMES_PLAYTIME_DISABLED',
      'GAMES_PLAYTIME_LIMIT_REACHED',
    ],
    handler: async ({ ctx, identity, params }) => {
      if (!ctx.config.features.games.playtime.enabled) {
        throw new ProblemError('GAMES_PLAYTIME_DISABLED');
      }
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      requireGameToken(identity, game.id);
      const limit = dailyLimitMinutes(identity);
      const result = await startPlaytimeSession(ctx.db, {
        gameId: game.id,
        userId,
        dailyLimitMinutes: limit,
        now: new Date(),
      });
      if (result.status === 'limit_reached') throw new ProblemError('GAMES_PLAYTIME_LIMIT_REACHED');
      return {
        status: 201 as const,
        body: {
          session_id: result.session.id,
          remaining_seconds: result.remaining_seconds,
          daily_limit_minutes: limit,
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/:slug/playtime/:session_id/heartbeat',
    operation_id: 'heartbeatPlaytime',
    summary: 'Record a playtime heartbeat',
    description: `Games should heartbeat at least every ${HEARTBEAT_INTERVAL_MESSAGE} seconds. Sessions without a recent heartbeat are closed automatically.`,
    tags: ['games', 'stats'],
    auth: 'oauth',
    scopes: [GAME_STATS_WRITE_SCOPE],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), session_id: z.uuid() }),
    },
    responses: {
      200: { description: 'The session', schema: playtimeHeartbeatResponseSchema },
    },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_WRONG_GAME_TOKEN',
      'GAMES_PLAYTIME_DISABLED',
      'GAMES_PLAYTIME_SESSION_NOT_FOUND',
    ],
    handler: async ({ ctx, identity, params }) => {
      if (!ctx.config.features.games.playtime.enabled) {
        throw new ProblemError('GAMES_PLAYTIME_DISABLED');
      }
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      requireGameToken(identity, game.id);
      const result = await heartbeatPlaytimeSession(ctx.db, {
        sessionId: params.session_id,
        userId,
        gameId: game.id,
        now: new Date(),
      });
      if (result.status !== 'ok') throw new ProblemError('GAMES_PLAYTIME_SESSION_NOT_FOUND');
      gamesMetrics(ctx.metrics).playtimeHeartbeat();
      return {
        status: 200 as const,
        body: {
          session_id: result.session.id,
          duration_seconds: result.session.duration_seconds,
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/:slug/playtime/:session_id/end',
    operation_id: 'endPlaytime',
    summary: 'Close a playtime session',
    tags: ['games', 'stats'],
    auth: 'oauth',
    scopes: [GAME_STATS_WRITE_SCOPE],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), session_id: z.uuid() }),
    },
    responses: { 200: { description: 'The session', schema: playtimeEndResponseSchema } },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_WRONG_GAME_TOKEN',
      'GAMES_PLAYTIME_DISABLED',
      'GAMES_PLAYTIME_SESSION_NOT_FOUND',
    ],
    handler: async ({ ctx, identity, params }) => {
      if (!ctx.config.features.games.playtime.enabled) {
        throw new ProblemError('GAMES_PLAYTIME_DISABLED');
      }
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      requireGameToken(identity, game.id);
      const result = await endPlaytimeSession(ctx.db, {
        sessionId: params.session_id,
        userId,
        gameId: game.id,
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status !== 'ok') throw new ProblemError('GAMES_PLAYTIME_SESSION_NOT_FOUND');
      ctx.outbox.wake();
      gamesMetrics(ctx.metrics).playtimeEnded();
      return {
        status: 200 as const,
        body: {
          session_id: result.session.id,
          duration_seconds: result.session.duration_seconds,
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/playtime/remaining',
    operation_id: 'remainingPlaytime',
    summary: 'The player’s remaining daily playtime for a game',
    description:
      'Games call this to enforce the parental daily_playtime_minutes control. Returns null when no daily limit applies.',
    tags: ['games', 'stats'],
    auth: 'oauth',
    scopes: [GAME_STATS_WRITE_SCOPE],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: { 200: { description: 'Remaining playtime', schema: playtimeRemainingSchema } },
    errors: ['GAMES_NOT_FOUND', 'GAMES_WRONG_GAME_TOKEN', 'GAMES_PLAYTIME_DISABLED'],
    handler: async ({ ctx, identity, params }) => {
      if (!ctx.config.features.games.playtime.enabled) {
        throw new ProblemError('GAMES_PLAYTIME_DISABLED');
      }
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      requireGameToken(identity, game.id);
      const limit = dailyLimitMinutes(identity);
      const remaining = await remainingPlaytimeSeconds(ctx.db, {
        userId,
        gameId: game.id,
        dailyLimitMinutes: limit,
        now: new Date(),
      });
      return {
        status: 200 as const,
        body: {
          remaining_seconds: remaining.remaining_seconds,
          used_seconds: remaining.used_seconds,
          daily_limit_minutes: limit,
        },
      };
    },
  });
}
