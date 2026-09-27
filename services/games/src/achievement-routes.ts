import { ACHIEVEMENTS_WRITE_SCOPE } from '@qtiauth/config';
import type { GameTrustLevel } from '@qtiauth/events';
import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import {
  type AchievementUnlockRecord,
  listPlayerAchievements,
  type PlayerAchievementView,
  progressAchievement,
  unlockAchievement,
} from './achievements.ts';
import { getGameBySlug, isPublicGame } from './catalog.ts';
import { gamesMetrics } from './metrics.ts';
import { signedIn } from './routes.ts';
import type { Context } from './service.ts';

const publicAchievementSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  points: z.int(),
  hidden: z.boolean(),
  progress_target: z.int().nullable(),
  rarity: z.number().nullable(),
});

const playerAchievementSchema = publicAchievementSchema.extend({
  progress: z.int(),
  unlocked_at: z.iso.datetime().nullable(),
});

const unlockBody = z.object({
  slug: z.string().min(1),
});

const progressBody = z.object({
  slug: z.string().min(1),
  progress: z.int().min(0),
});

const unlockResponseSchema = z.object({
  slug: z.string(),
  progress: z.int(),
  progress_target: z.int().nullable(),
  unlocked_at: z.iso.datetime().nullable(),
});

function playerView(record: PlayerAchievementView) {
  const unlocked = record.unlocked_at !== null;
  const revealHidden = !record.hidden || unlocked;
  return {
    slug: record.slug,
    name: revealHidden ? record.name : '',
    description: revealHidden ? record.description : '',
    icon: revealHidden ? record.icon : null,
    points: record.points,
    hidden: record.hidden,
    progress_target: record.progress_target,
    rarity: record.rarity,
    progress: record.progress,
    unlocked_at: record.unlocked_at?.toISOString() ?? null,
  };
}

async function requirePublicGame(ctx: Context, slug: string) {
  const game = await getGameBySlug(ctx.db, slug);
  if (!game || !isPublicGame(game.status)) throw new ProblemError('GAMES_NOT_FOUND');
  return game;
}

function requireGameToken(identity: { game_id: string | null }, gameId: string): void {
  if (identity.game_id === null || identity.game_id !== gameId) {
    throw new ProblemError('GAMES_ACHIEVEMENT_WRONG_GAME');
  }
}

function trustLevel(auth: string): GameTrustLevel {
  return auth === 'game_authoritative' ? 'game' : 'player';
}

function unlockResponse(
  slug: string,
  target: number | null,
  unlock: AchievementUnlockRecord,
): z.output<typeof unlockResponseSchema> {
  return {
    slug,
    progress: unlock.progress,
    progress_target: target,
    unlocked_at: unlock.unlocked_at?.toISOString() ?? null,
  };
}

export function achievementRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/achievements',
    operation_id: 'listGameAchievements',
    summary: 'Achievements for a game',
    description:
      'Signed-in players see their own progress and unlock times. Hidden achievements stay masked until unlocked.',
    tags: ['games', 'achievements'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: {
      200: {
        description: 'Achievements with the player’s progress',
        schema: z.object({ items: z.array(playerAchievementSchema) }),
      },
    },
    errors: ['GAMES_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      const rows = await listPlayerAchievements(ctx.db, { gameId: game.id, userId });
      return { status: 200 as const, body: { items: rows.map(playerView) } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/:slug/achievements/unlock',
    operation_id: 'unlockGameAchievement',
    summary: 'Unlock an achievement for the player',
    description:
      'Accepted with the player’s access token for the game (trust: player) or a game-authoritative write (trust: game). The token must be issued to this game’s client.',
    tags: ['games', 'achievements'],
    auth: 'oauth',
    scopes: [ACHIEVEMENTS_WRITE_SCOPE],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }), body: unlockBody },
    responses: {
      200: {
        description: 'The unlock',
        schema: unlockResponseSchema,
      },
    },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_ACHIEVEMENT_NOT_FOUND',
      'GAMES_ACHIEVEMENT_NOT_PROGRESS',
      'GAMES_ACHIEVEMENT_WRONG_GAME',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      requireGameToken(identity, game.id);
      const trust = trustLevel(identity.auth);
      const result = await unlockAchievement(ctx.db, {
        gameId: game.id,
        slug: body.slug,
        userId,
        trust,
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GAMES_ACHIEVEMENT_NOT_FOUND');
      if (result.status === 'not_progress') {
        throw new ProblemError('GAMES_ACHIEVEMENT_NOT_PROGRESS');
      }
      if (result.unlocked) {
        ctx.outbox.wake();
        gamesMetrics(ctx.metrics).achievementUnlocked(trust);
      }
      return { status: 200 as const, body: unlockResponse(body.slug, null, result.unlock) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/:slug/achievements/progress',
    operation_id: 'progressGameAchievement',
    summary: 'Record progress on a progress achievement',
    description:
      'Progress only ever increases and caps at the target. Reaching the target unlocks the achievement.',
    tags: ['games', 'achievements'],
    auth: 'oauth',
    scopes: [ACHIEVEMENTS_WRITE_SCOPE],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }), body: progressBody },
    responses: {
      200: {
        description: 'The unlock or updated progress',
        schema: unlockResponseSchema,
      },
    },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_ACHIEVEMENT_NOT_FOUND',
      'GAMES_ACHIEVEMENT_NOT_PROGRESS',
      'GAMES_ACHIEVEMENT_INVALID',
      'GAMES_ACHIEVEMENT_WRONG_GAME',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      requireGameToken(identity, game.id);
      const trust = trustLevel(identity.auth);
      const result = await progressAchievement(ctx.db, {
        gameId: game.id,
        slug: body.slug,
        userId,
        progress: body.progress,
        trust,
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GAMES_ACHIEVEMENT_NOT_FOUND');
      if (result.status === 'not_progress') {
        throw new ProblemError('GAMES_ACHIEVEMENT_NOT_PROGRESS');
      }
      if (result.status === 'invalid') throw new ProblemError('GAMES_ACHIEVEMENT_INVALID');
      if (result.changed) {
        ctx.outbox.wake();
        if (result.unlocked) gamesMetrics(ctx.metrics).achievementUnlocked(trust);
        else gamesMetrics(ctx.metrics).achievementProgressed(trust);
      }
      const target = await ctx.db
        .selectFrom('achievements')
        .select(['progress_target'])
        .where('id', '=', result.unlock.achievement_id)
        .executeTakeFirst();
      return {
        status: 200 as const,
        body: unlockResponse(body.slug, target?.progress_target ?? null, result.unlock),
      };
    },
  });
}
