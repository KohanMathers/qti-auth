import {
  GAME_ACHIEVEMENT_DESCRIPTION_MAX,
  GAME_ACHIEVEMENT_NAME_MAX,
  GAME_ART_MAX,
  GAME_REVOKE_REASON_MAX,
  GAME_SLUG,
  GAME_SLUG_MESSAGE,
} from '@qtiauth/config';
import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import {
  type AchievementRecord,
  type AchievementView,
  createAchievement,
  deleteAchievement,
  listAchievementViews,
  revokeUnlock,
  updateAchievement,
} from './achievements.ts';
import { getGameBySlug } from './catalog.ts';
import { gamesMetrics } from './metrics.ts';
import { signedIn } from './routes.ts';
import type { Context } from './service.ts';

const achievementSlug = z.string().min(1).max(80).regex(GAME_SLUG, GAME_SLUG_MESSAGE);

const createBody = z.object({
  slug: achievementSlug,
  name: z.string().min(1).max(GAME_ACHIEVEMENT_NAME_MAX),
  description: z.string().max(GAME_ACHIEVEMENT_DESCRIPTION_MAX).default(''),
  icon: z.string().max(GAME_ART_MAX).nullable().default(null),
  points: z.int().min(0).max(1_000_000).default(0),
  hidden: z.boolean().default(false),
  progress_target: z.int().min(1).max(1_000_000_000).nullable().default(null),
});

const patchBody = z.object({
  slug: achievementSlug.optional(),
  name: z.string().min(1).max(GAME_ACHIEVEMENT_NAME_MAX).optional(),
  description: z.string().max(GAME_ACHIEVEMENT_DESCRIPTION_MAX).optional(),
  icon: z.string().max(GAME_ART_MAX).nullable().optional(),
  points: z.int().min(0).max(1_000_000).optional(),
  hidden: z.boolean().optional(),
  progress_target: z.int().min(1).max(1_000_000_000).nullable().optional(),
});

const revokeBody = z.object({
  reason: z.string().trim().min(1).max(GAME_REVOKE_REASON_MAX),
});

const achievementSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  points: z.int(),
  hidden: z.boolean(),
  progress_target: z.int().nullable(),
  rarity: z.number().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const revokeResponseSchema = z.object({
  unlock_id: z.uuid(),
  achievement_slug: z.string(),
  user_id: z.uuid(),
  revoked_at: z.iso.datetime(),
  revoke_reason: z.string(),
});

function achievementView(view: AchievementView) {
  return {
    id: view.id,
    slug: view.slug,
    name: view.name,
    description: view.description,
    icon: view.icon,
    points: view.points,
    hidden: view.hidden,
    progress_target: view.progress_target,
    rarity: view.rarity,
    created_at: view.created_at.toISOString(),
    updated_at: view.updated_at.toISOString(),
  };
}

function fromRecord(record: AchievementRecord): AchievementView {
  return { ...record, rarity: null };
}

async function requireGame(ctx: Context, slug: string) {
  const game = await getGameBySlug(ctx.db, slug);
  if (!game) throw new ProblemError('GAMES_NOT_FOUND');
  return game;
}

function writeError(status: string): never {
  if (status === 'not_found') throw new ProblemError('GAMES_ACHIEVEMENT_NOT_FOUND');
  if (status === 'slug_taken') throw new ProblemError('GAMES_ACHIEVEMENT_SLUG_TAKEN');
  throw new ProblemError('GAMES_ACHIEVEMENT_INVALID');
}

export function achievementAdminRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/games/:slug/achievements',
    operation_id: 'listAdminAchievements',
    summary: 'Achievements for a game, with rarity',
    tags: ['games', 'achievements', 'admin'],
    auth: 'session',
    permissions: ['games.achievements.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: {
      200: {
        description: 'Achievements',
        schema: z.object({ items: z.array(achievementSchema) }),
      },
    },
    errors: ['GAMES_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const game = await requireGame(ctx, params.slug);
      const rows = await listAchievementViews(ctx.db, game.id);
      return { status: 200 as const, body: { items: rows.map(achievementView) } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/games/:slug/achievements',
    operation_id: 'createAdminAchievement',
    summary: 'Create an achievement',
    tags: ['games', 'achievements', 'admin'],
    auth: 'session',
    permissions: ['games.achievements.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }), body: createBody },
    responses: { 201: { description: 'The achievement', schema: achievementSchema } },
    errors: ['GAMES_NOT_FOUND', 'GAMES_ACHIEVEMENT_SLUG_TAKEN', 'GAMES_ACHIEVEMENT_INVALID'],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const result = await createAchievement(ctx.db, {
        gameId: game.id,
        slug: body.slug,
        name: body.name,
        description: body.description,
        icon: body.icon,
        points: body.points,
        hidden: body.hidden,
        progress_target: body.progress_target,
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status !== 'ok') writeError(result.status);
      ctx.outbox.wake();
      return { status: 201 as const, body: achievementView(fromRecord(result.achievement)) };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/admin/games/:slug/achievements/:achievement_slug',
    operation_id: 'updateAdminAchievement',
    summary: 'Update an achievement',
    tags: ['games', 'achievements', 'admin'],
    auth: 'session',
    permissions: ['games.achievements.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), achievement_slug: z.string().min(1) }),
      body: patchBody,
    },
    responses: { 200: { description: 'The achievement', schema: achievementSchema } },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_ACHIEVEMENT_NOT_FOUND',
      'GAMES_ACHIEVEMENT_SLUG_TAKEN',
      'GAMES_ACHIEVEMENT_INVALID',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const result = await updateAchievement(ctx.db, {
        gameId: game.id,
        currentSlug: params.achievement_slug,
        ...(body.slug === undefined ? {} : { slug: body.slug }),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.icon === undefined ? {} : { icon: body.icon }),
        ...(body.points === undefined ? {} : { points: body.points }),
        ...(body.hidden === undefined ? {} : { hidden: body.hidden }),
        ...(body.progress_target === undefined ? {} : { progress_target: body.progress_target }),
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status !== 'ok') writeError(result.status);
      ctx.outbox.wake();
      return { status: 200 as const, body: achievementView(fromRecord(result.achievement)) };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/games/:slug/achievements/:achievement_slug',
    operation_id: 'deleteAdminAchievement',
    summary: 'Delete an achievement and its unlocks',
    tags: ['games', 'achievements', 'admin'],
    auth: 'session',
    permissions: ['games.achievements.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), achievement_slug: z.string().min(1) }),
    },
    responses: { 204: { description: 'Deleted' } },
    errors: ['GAMES_NOT_FOUND', 'GAMES_ACHIEVEMENT_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const result = await deleteAchievement(ctx.db, {
        gameId: game.id,
        slug: params.achievement_slug,
        actor: { type: 'user', id: actorId },
      });
      if (result.status !== 'ok') throw new ProblemError('GAMES_ACHIEVEMENT_NOT_FOUND');
      ctx.outbox.wake();
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/achievement-unlocks/:unlock_id/revoke',
    operation_id: 'revokeAdminAchievementUnlock',
    summary: 'Revoke a player’s achievement unlock',
    description: 'Emits qtiauth.games.achievement.revoked.v1 and writes an audit record.',
    tags: ['games', 'achievements', 'admin'],
    auth: 'session',
    permissions: ['games.achievements.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ unlock_id: z.uuid() }),
      body: revokeBody,
    },
    responses: { 200: { description: 'The revoked unlock', schema: revokeResponseSchema } },
    errors: ['GAMES_ACHIEVEMENT_UNLOCK_NOT_FOUND', 'GAMES_ACHIEVEMENT_UNLOCK_NOT_UNLOCKED'],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const now = new Date();
      const result = await revokeUnlock(ctx.db, {
        unlockId: params.unlock_id,
        reason: body.reason,
        actor: { type: 'user', id: actorId },
        now,
      });
      if (result.status === 'not_found') {
        throw new ProblemError('GAMES_ACHIEVEMENT_UNLOCK_NOT_FOUND');
      }
      if (result.status === 'not_unlocked') {
        throw new ProblemError('GAMES_ACHIEVEMENT_UNLOCK_NOT_UNLOCKED');
      }
      ctx.outbox.wake();
      gamesMetrics(ctx.metrics).achievementRevoked();
      return {
        status: 200 as const,
        body: {
          unlock_id: result.unlock.id,
          achievement_slug: result.achievement.slug,
          user_id: result.unlock.user_id,
          revoked_at: now.toISOString(),
          revoke_reason: body.reason,
        },
      };
    },
  });
}
