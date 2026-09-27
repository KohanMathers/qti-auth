import {
  CLOUD_SAVE_CONTENT_TYPE_MAX,
  CLOUD_SAVE_SLOT,
  CLOUD_SAVE_SLOT_MESSAGE,
} from '@qtiauth/config';
import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { getGameBySlug, isPublicGame } from './catalog.ts';
import {
  abandonUpload,
  commitUpload,
  type CloudSaveSlotRecord,
  type CloudSaveVersionRecord,
  deleteSlot,
  getSlot,
  getVersion,
  listSlots,
  listVersions,
  type SlotView,
  startUpload,
} from './cloud-saves.ts';
import { gamesMetrics } from './metrics.ts';
import { signedIn } from './routes.ts';
import type { Context } from './service.ts';
import { cloudSaveQuotaBytes } from './settings.ts';
import { objectStoreOf } from './storage-state.ts';

const slotParam = z.string().min(1).max(64).regex(CLOUD_SAVE_SLOT, CLOUD_SAVE_SLOT_MESSAGE);

const startUploadBody = z.object({
  size_bytes: z.int().min(0),
  base_version: z.int().min(0).nullable().default(null),
  content_type: z
    .string()
    .trim()
    .min(1)
    .max(CLOUD_SAVE_CONTENT_TYPE_MAX)
    .default('application/octet-stream'),
});

const commitBody = z.object({
  version_id: z.uuid(),
});

const versionSchema = z.object({
  version: z.int(),
  version_id: z.uuid(),
  size_bytes: z.int(),
  content_type: z.string(),
  created_at: z.iso.datetime(),
  committed_at: z.iso.datetime().nullable(),
});

const slotSchema = z.object({
  slot: z.string(),
  size_bytes: z.int(),
  current_version: z.int().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const slotDetailSchema = slotSchema.extend({
  current: versionSchema.nullable(),
});

const startUploadResponseSchema = z.object({
  slot: slotSchema,
  version: versionSchema,
  upload_url: z.string(),
  expires_at: z.iso.datetime(),
});

const commitResponseSchema = z.object({
  slot: slotSchema,
  version: versionSchema,
});

const downloadResponseSchema = z.object({
  slot: z.string(),
  version: z.int(),
  size_bytes: z.int(),
  content_type: z.string(),
  download_url: z.string(),
  expires_at: z.iso.datetime(),
});

function requireCloudSavesEnabled(ctx: Context): void {
  if (!ctx.config.features.games.cloud_saves.enabled) {
    throw new ProblemError('GAMES_CLOUD_SAVES_DISABLED');
  }
}

function requireStore(ctx: Context) {
  const store = objectStoreOf(ctx);
  if (!store) throw new ProblemError('GAMES_CLOUD_SAVES_UNAVAILABLE');
  return store;
}

function slotView(slot: CloudSaveSlotRecord, current: CloudSaveVersionRecord | null) {
  return {
    slot: slot.slot,
    size_bytes: slot.size_bytes,
    current_version: current?.version ?? null,
    created_at: slot.created_at.toISOString(),
    updated_at: slot.updated_at.toISOString(),
  };
}

function versionView(version: CloudSaveVersionRecord) {
  return {
    version: version.version,
    version_id: version.id,
    size_bytes: version.size_bytes,
    content_type: version.content_type,
    created_at: version.created_at.toISOString(),
    committed_at: version.committed_at?.toISOString() ?? null,
  };
}

function slotDetailView(view: SlotView) {
  return {
    ...slotView(view.slot, view.current),
    current: view.current === null ? null : versionView(view.current),
  };
}

export function cloudSaveRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/cloud-saves',
    operation_id: 'listCloudSaveSlots',
    summary: 'Cloud save slots for a game',
    tags: ['games', 'cloud-saves'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: {
      200: {
        description: 'Slots',
        schema: z.object({ items: z.array(slotDetailSchema) }),
      },
    },
    errors: ['GAMES_CLOUD_SAVES_DISABLED', 'GAMES_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      requireCloudSavesEnabled(ctx);
      const userId = signedIn(identity);
      const game = await getGameBySlug(ctx.db, params.slug);
      if (!game || !isPublicGame(game.status)) throw new ProblemError('GAMES_NOT_FOUND');
      const slots = await listSlots(ctx.db, { userId, gameId: game.id });
      return {
        status: 200 as const,
        body: { items: slots.map(slotDetailView) },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/cloud-saves/:slot',
    operation_id: 'getCloudSaveSlot',
    summary: 'Cloud save slot detail',
    tags: ['games', 'cloud-saves'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1), slot: slotParam }) },
    responses: { 200: { description: 'The slot', schema: slotDetailSchema } },
    errors: ['GAMES_CLOUD_SAVES_DISABLED', 'GAMES_NOT_FOUND', 'GAMES_CLOUD_SAVE_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      requireCloudSavesEnabled(ctx);
      const userId = signedIn(identity);
      const game = await getGameBySlug(ctx.db, params.slug);
      if (!game || !isPublicGame(game.status)) throw new ProblemError('GAMES_NOT_FOUND');
      const view = await getSlot(ctx.db, { userId, gameId: game.id, slot: params.slot });
      if (!view) throw new ProblemError('GAMES_CLOUD_SAVE_NOT_FOUND');
      return { status: 200 as const, body: slotDetailView(view) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/cloud-saves/:slot/versions',
    operation_id: 'listCloudSaveVersions',
    summary: 'Committed versions of a cloud save slot',
    tags: ['games', 'cloud-saves'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1), slot: slotParam }) },
    responses: {
      200: {
        description: 'Versions, newest first',
        schema: z.object({ items: z.array(versionSchema) }),
      },
    },
    errors: ['GAMES_CLOUD_SAVES_DISABLED', 'GAMES_NOT_FOUND', 'GAMES_CLOUD_SAVE_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      requireCloudSavesEnabled(ctx);
      const userId = signedIn(identity);
      const game = await getGameBySlug(ctx.db, params.slug);
      if (!game || !isPublicGame(game.status)) throw new ProblemError('GAMES_NOT_FOUND');
      const view = await getSlot(ctx.db, { userId, gameId: game.id, slot: params.slot });
      if (!view) throw new ProblemError('GAMES_CLOUD_SAVE_NOT_FOUND');
      const versions = await listVersions(ctx.db, view.slot.id);
      return {
        status: 200 as const,
        body: { items: versions.map(versionView) },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/:slug/cloud-saves/:slot/uploads',
    operation_id: 'startCloudSaveUpload',
    summary: 'Start a new cloud save upload',
    description:
      'Reserves the next version of a slot, checks the base_version precondition and returns a presigned URL the client uploads the blob to. Commit the version once the upload finishes.',
    tags: ['games', 'cloud-saves'],
    auth: 'session',
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), slot: slotParam }),
      body: startUploadBody,
    },
    responses: {
      201: {
        description: 'The reserved version and its upload URL',
        schema: startUploadResponseSchema,
      },
    },
    errors: [
      'GAMES_CLOUD_SAVES_DISABLED',
      'GAMES_CLOUD_SAVES_UNAVAILABLE',
      'GAMES_NOT_FOUND',
      'GAMES_CLOUD_SAVE_SLOT_LIMIT',
      'GAMES_CLOUD_SAVE_QUOTA',
      'GAMES_CLOUD_SAVE_TOO_LARGE',
      'GAMES_CLOUD_SAVE_CONFLICT',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      requireCloudSavesEnabled(ctx);
      const store = requireStore(ctx);
      const userId = signedIn(identity);
      const game = await getGameBySlug(ctx.db, params.slug);
      if (!game || !isPublicGame(game.status)) throw new ProblemError('GAMES_NOT_FOUND');
      const config = ctx.config.games.cloud_saves;
      if (body.size_bytes > config.max_object_bytes) {
        throw new ProblemError('GAMES_CLOUD_SAVE_TOO_LARGE');
      }
      const metrics = gamesMetrics(ctx.metrics);
      const now = new Date();
      const outcome = await startUpload(ctx.db, {
        userId,
        gameId: game.id,
        slot: params.slot,
        sizeBytes: body.size_bytes,
        contentType: body.content_type,
        baseVersion: body.base_version,
        quotaBytes: cloudSaveQuotaBytes(ctx.config, game),
        maxSlots: config.max_slots_per_game,
        now,
      });
      metrics.cloudSaveUpload(outcome.status);
      if (outcome.status === 'slot_limit') {
        throw new ProblemError('GAMES_CLOUD_SAVE_SLOT_LIMIT');
      }
      if (outcome.status === 'quota') throw new ProblemError('GAMES_CLOUD_SAVE_QUOTA');
      if (outcome.status === 'conflict') {
        throw new ProblemError('GAMES_CLOUD_SAVE_CONFLICT', {
          extensions: { current_version: outcome.current?.version ?? null },
        });
      }
      const expiresSeconds = Math.max(1, Math.round(config.upload_ttl / 1_000));
      const uploadUrl = await store.presignPut(
        outcome.version.object_key,
        outcome.version.content_type,
        expiresSeconds,
      );
      return {
        status: 201 as const,
        body: {
          slot: slotView(outcome.slot, null),
          version: versionView(outcome.version),
          upload_url: uploadUrl,
          expires_at: new Date(now.getTime() + expiresSeconds * 1_000).toISOString(),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/:slug/cloud-saves/:slot/commit',
    operation_id: 'commitCloudSaveUpload',
    summary: 'Commit an uploaded cloud save version',
    description:
      'Marks a reserved version as the current version of its slot, once the upload has finished. Older versions beyond versions_per_slot are pruned.',
    tags: ['games', 'cloud-saves'],
    auth: 'session',
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), slot: slotParam }),
      body: commitBody,
    },
    responses: {
      200: { description: 'The new current version', schema: commitResponseSchema },
    },
    errors: [
      'GAMES_CLOUD_SAVES_DISABLED',
      'GAMES_CLOUD_SAVES_UNAVAILABLE',
      'GAMES_NOT_FOUND',
      'GAMES_CLOUD_SAVE_NOT_FOUND',
      'GAMES_CLOUD_SAVE_ALREADY_COMMITTED',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      requireCloudSavesEnabled(ctx);
      const store = requireStore(ctx);
      const userId = signedIn(identity);
      const game = await getGameBySlug(ctx.db, params.slug);
      if (!game || !isPublicGame(game.status)) throw new ProblemError('GAMES_NOT_FOUND');
      const result = await commitUpload(ctx.db, {
        userId,
        gameId: game.id,
        slot: params.slot,
        versionId: body.version_id,
        versionsPerSlot: ctx.config.games.cloud_saves.versions_per_slot,
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GAMES_CLOUD_SAVE_NOT_FOUND');
      if (result.status === 'already_committed') {
        throw new ProblemError('GAMES_CLOUD_SAVE_ALREADY_COMMITTED');
      }
      for (const key of result.pruned) await store.delete(key);
      gamesMetrics(ctx.metrics).cloudSaveCommitted(result.version.size_bytes);
      ctx.outbox.wake();
      return {
        status: 200 as const,
        body: {
          slot: slotView(result.slot, result.version),
          version: versionView(result.version),
        },
      };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/games/:slug/cloud-saves/:slot/uploads/:version_id',
    operation_id: 'abandonCloudSaveUpload',
    summary: 'Drop a reserved but uncommitted cloud save upload',
    tags: ['games', 'cloud-saves'],
    auth: 'session',
    rate_limit: 'global',
    request: {
      params: z.object({
        slug: z.string().min(1),
        slot: slotParam,
        version_id: z.uuid(),
      }),
    },
    responses: { 204: { description: 'Abandoned' } },
    errors: [
      'GAMES_CLOUD_SAVES_DISABLED',
      'GAMES_CLOUD_SAVES_UNAVAILABLE',
      'GAMES_NOT_FOUND',
      'GAMES_CLOUD_SAVE_NOT_FOUND',
    ],
    handler: async ({ ctx, identity, params }) => {
      requireCloudSavesEnabled(ctx);
      const store = requireStore(ctx);
      const userId = signedIn(identity);
      const game = await getGameBySlug(ctx.db, params.slug);
      if (!game || !isPublicGame(game.status)) throw new ProblemError('GAMES_NOT_FOUND');
      const view = await getSlot(ctx.db, { userId, gameId: game.id, slot: params.slot });
      if (!view) throw new ProblemError('GAMES_CLOUD_SAVE_NOT_FOUND');
      const objectKey = await abandonUpload(ctx.db, {
        versionId: params.version_id,
        slotId: view.slot.id,
      });
      if (objectKey === null) throw new ProblemError('GAMES_CLOUD_SAVE_NOT_FOUND');
      await store.delete(objectKey);
      return new Response(null, { status: 204 });
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/cloud-saves/:slot/download',
    operation_id: 'downloadCloudSave',
    summary: 'Presigned download URL for the current cloud save version',
    tags: ['games', 'cloud-saves'],
    auth: 'session',
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), slot: slotParam }),
      query: z.object({ version: z.coerce.number().int().min(1).optional() }),
    },
    responses: { 200: { description: 'The download URL', schema: downloadResponseSchema } },
    errors: [
      'GAMES_CLOUD_SAVES_DISABLED',
      'GAMES_CLOUD_SAVES_UNAVAILABLE',
      'GAMES_NOT_FOUND',
      'GAMES_CLOUD_SAVE_NOT_FOUND',
      'GAMES_CLOUD_SAVE_VERSION_NOT_FOUND',
      'GAMES_CLOUD_SAVE_NOT_COMMITTED',
    ],
    handler: async ({ ctx, identity, params, query }) => {
      requireCloudSavesEnabled(ctx);
      const store = requireStore(ctx);
      const userId = signedIn(identity);
      const game = await getGameBySlug(ctx.db, params.slug);
      if (!game || !isPublicGame(game.status)) throw new ProblemError('GAMES_NOT_FOUND');
      const view = await getSlot(ctx.db, { userId, gameId: game.id, slot: params.slot });
      if (!view) throw new ProblemError('GAMES_CLOUD_SAVE_NOT_FOUND');
      let version: CloudSaveVersionRecord | null;
      if (query.version === undefined) {
        version = view.current;
        if (version === null) throw new ProblemError('GAMES_CLOUD_SAVE_NOT_COMMITTED');
      } else {
        const found = await getVersion(ctx.db, {
          slotId: view.slot.id,
          version: query.version,
        });
        if (!found) throw new ProblemError('GAMES_CLOUD_SAVE_VERSION_NOT_FOUND');
        if (found.committed_at === null) throw new ProblemError('GAMES_CLOUD_SAVE_NOT_COMMITTED');
        version = found;
      }
      const now = new Date();
      const expiresSeconds = Math.max(
        1,
        Math.round(ctx.config.games.cloud_saves.download_ttl / 1_000),
      );
      const url = await store.presignGet(version.object_key, expiresSeconds, {
        contentType: version.content_type,
      });
      gamesMetrics(ctx.metrics).cloudSaveDownloaded();
      return {
        status: 200 as const,
        body: {
          slot: view.slot.slot,
          version: version.version,
          size_bytes: version.size_bytes,
          content_type: version.content_type,
          download_url: url,
          expires_at: new Date(now.getTime() + expiresSeconds * 1_000).toISOString(),
        },
      };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/games/:slug/cloud-saves/:slot',
    operation_id: 'deleteCloudSaveSlot',
    summary: 'Delete a cloud save slot and all of its versions',
    tags: ['games', 'cloud-saves'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1), slot: slotParam }) },
    responses: { 204: { description: 'Deleted' } },
    errors: [
      'GAMES_CLOUD_SAVES_DISABLED',
      'GAMES_CLOUD_SAVES_UNAVAILABLE',
      'GAMES_NOT_FOUND',
      'GAMES_CLOUD_SAVE_NOT_FOUND',
    ],
    handler: async ({ ctx, identity, params }) => {
      requireCloudSavesEnabled(ctx);
      const store = requireStore(ctx);
      const userId = signedIn(identity);
      const game = await getGameBySlug(ctx.db, params.slug);
      if (!game || !isPublicGame(game.status)) throw new ProblemError('GAMES_NOT_FOUND');
      const result = await deleteSlot(ctx.db, {
        userId,
        gameId: game.id,
        slot: params.slot,
        reason: 'user_deleted',
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GAMES_CLOUD_SAVE_NOT_FOUND');
      await store.deletePrefix(result.prefix);
      gamesMetrics(ctx.metrics).cloudSaveDeleted();
      ctx.outbox.wake();
      return new Response(null, { status: 204 });
    },
  });
}
