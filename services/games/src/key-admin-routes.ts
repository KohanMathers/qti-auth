import { randomUUID } from 'node:crypto';

import { GAME_KEY_LABEL_MAX, GAME_REVOKE_REASON_MAX } from '@qtiauth/config';
import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import { getGameBySlug, listProducts } from './catalog.ts';
import {
  batchCsv,
  createKeyBatch,
  exportBatchKeys,
  getKeyBatch,
  type KeyBatchRecord,
  type KeyBatchSummary,
  listBatchKeys,
  listKeyBatches,
  revokeKeyBatch,
} from './keys.ts';
import { gamesMetrics } from './metrics.ts';
import { signedIn } from './routes.ts';
import type { Context } from './service.ts';
import { gamesEncryptionKey } from './settings.ts';

const generateBody = z.object({
  count: z.int().min(1),
  label: z.string().trim().min(1).max(GAME_KEY_LABEL_MAX),
  expires_at: z.iso.datetime().nullable().default(null),
});

const revokeBody = z.object({
  reason: z.string().trim().min(1).max(GAME_REVOKE_REASON_MAX),
  revoke_entitlements: z.boolean().default(false),
});

const batchSchema = z.object({
  id: z.uuid(),
  game_slug: z.string(),
  product_slug: z.string(),
  label: z.string(),
  format: z.string(),
  total_keys: z.int(),
  redeemed_keys: z.int(),
  expires_at: z.iso.datetime().nullable(),
  created_by: z.uuid().nullable(),
  created_at: z.iso.datetime(),
  revoked_at: z.iso.datetime().nullable(),
  revoke_reason: z.string().nullable(),
});

const generateResponseSchema = batchSchema.extend({
  codes: z.array(z.string()),
});

const keySchema = z.object({
  id: z.uuid(),
  code_display: z.string(),
  redeemed_at: z.iso.datetime().nullable(),
  revoked_at: z.iso.datetime().nullable(),
});

const revokeResponseSchema = z.object({
  batch: batchSchema,
  keys_revoked: z.int(),
  entitlements_revoked: z.int(),
});

const createdPosition = z.object({ created_at: z.iso.datetime(), id: z.uuid() });

function batchView(
  batch: KeyBatchSummary | (KeyBatchRecord & { redeemed_keys: number }),
  gameSlug: string,
  productSlug: string,
): z.output<typeof batchSchema> {
  return {
    id: batch.id,
    game_slug: gameSlug,
    product_slug: productSlug,
    label: batch.label,
    format: batch.format,
    total_keys: batch.total_keys,
    redeemed_keys: batch.redeemed_keys,
    expires_at: batch.expires_at?.toISOString() ?? null,
    created_by: batch.created_by,
    created_at: batch.created_at.toISOString(),
    revoked_at: batch.revoked_at?.toISOString() ?? null,
    revoke_reason: batch.revoke_reason,
  };
}

async function resolveBatchLabels(
  ctx: Context,
  batch: { game_id: string; product_id: string },
): Promise<{ gameSlug: string; productSlug: string }> {
  const [game, product] = await Promise.all([
    ctx.db.selectFrom('games').select(['slug']).where('id', '=', batch.game_id).executeTakeFirst(),
    ctx.db
      .selectFrom('products')
      .select(['slug'])
      .where('id', '=', batch.product_id)
      .executeTakeFirst(),
  ]);
  return { gameSlug: game?.slug ?? '', productSlug: product?.slug ?? '' };
}

export function keyAdminRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/games/:slug/key-batches',
    operation_id: 'listAdminKeyBatches',
    summary: 'Key batches for a game',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.keys.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1) }),
      query: paginationQuery({ defaultLimit: 25, maxLimit: 100 }),
    },
    responses: { 200: { description: 'Key batches', schema: pageSchema(batchSchema) } },
    errors: ['GAMES_KEYS_DISABLED', 'GAMES_NOT_FOUND'],
    handler: async ({ ctx, params, query }) => {
      if (!ctx.config.features.games.keys.enabled) throw new ProblemError('GAMES_KEYS_DISABLED');
      const game = await getGameBySlug(ctx.db, params.slug);
      if (!game) throw new ProblemError('GAMES_NOT_FOUND');
      const after = decodeCursor(createdPosition, query.cursor);
      const rows = await listKeyBatches(ctx.db, {
        gameId: game.id,
        ...(after === undefined ? {} : { after }),
        limit: query.limit + 1,
      });
      const productSlugs = new Map(
        (await listProducts(ctx.db, game.id)).map((product) => [product.id, product.slug]),
      );
      const page = pageOf(rows, query.limit, (batch) => ({
        created_at: batch.created_at.toISOString(),
        id: batch.id,
      }));
      const items = page.items.map((batch) =>
        batchView(batch, game.slug, productSlugs.get(batch.product_id) ?? ''),
      );
      return { status: 200 as const, body: { items, next_cursor: page.next_cursor } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/games/:slug/products/:product_slug/key-batches',
    operation_id: 'createAdminKeyBatch',
    summary: 'Generate a key batch',
    description:
      'The generated codes are returned once in this response and never again. Later exports through /api/v1/admin/key-batches/:batch_id/keys.csv also return the codes but need step-up.',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.keys.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), product_slug: z.string().min(1) }),
      body: generateBody,
    },
    responses: {
      201: { description: 'The batch and its plaintext codes', schema: generateResponseSchema },
    },
    errors: [
      'GAMES_KEYS_DISABLED',
      'GAMES_NOT_FOUND',
      'GAMES_PRODUCT_NOT_FOUND',
      'GAMES_KEY_BATCH_INVALID',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      if (!ctx.config.features.games.keys.enabled) throw new ProblemError('GAMES_KEYS_DISABLED');
      const actorId = signedIn(identity);
      const game = await getGameBySlug(ctx.db, params.slug);
      if (!game) throw new ProblemError('GAMES_NOT_FOUND');
      const product = (await listProducts(ctx.db, game.id)).find(
        (row) => row.slug === params.product_slug,
      );
      if (!product) throw new ProblemError('GAMES_PRODUCT_NOT_FOUND');
      const keySettings = ctx.config.games.keys;
      if (body.count > keySettings.max_batch) {
        throw new ProblemError('GAMES_KEY_BATCH_INVALID');
      }
      const expiresAt = body.expires_at === null ? null : new Date(body.expires_at);
      const now = new Date();
      if (expiresAt !== null && expiresAt <= now) {
        throw new ProblemError('GAMES_KEY_BATCH_INVALID');
      }
      const { batch, codes } = await createKeyBatch(ctx.db, {
        id: randomUUID(),
        gameId: game.id,
        productId: product.id,
        label: body.label,
        format: {
          charset: keySettings.charset,
          group_length: keySettings.group_length,
          groups: keySettings.groups,
        },
        count: body.count,
        expiresAt,
        createdBy: actorId,
        encryptionKey: gamesEncryptionKey(ctx.config),
        now,
      });
      gamesMetrics(ctx.metrics).keysGenerated(codes.length);
      return {
        status: 201 as const,
        body: {
          ...batchView({ ...batch, redeemed_keys: 0 }, game.slug, product.slug),
          codes,
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/key-batches/:batch_id',
    operation_id: 'getAdminKeyBatch',
    summary: 'Key batch detail with masked keys',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.keys.manage'],
    rate_limit: 'global',
    request: { params: z.object({ batch_id: z.uuid() }) },
    responses: {
      200: {
        description: 'The batch and its masked keys',
        schema: batchSchema.extend({ keys: z.array(keySchema) }),
      },
    },
    errors: ['GAMES_KEYS_DISABLED', 'GAMES_KEY_BATCH_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      if (!ctx.config.features.games.keys.enabled) throw new ProblemError('GAMES_KEYS_DISABLED');
      const batch = await getKeyBatch(ctx.db, params.batch_id);
      if (!batch) throw new ProblemError('GAMES_KEY_BATCH_NOT_FOUND');
      const { gameSlug, productSlug } = await resolveBatchLabels(ctx, batch);
      const keys = await listBatchKeys(ctx.db, batch.id);
      return {
        status: 200 as const,
        body: {
          ...batchView(batch, gameSlug, productSlug),
          keys: keys.map((row) => ({
            id: row.id,
            code_display: row.code_display,
            redeemed_at: row.redeemed_at?.toISOString() ?? null,
            revoked_at: row.revoked_at?.toISOString() ?? null,
          })),
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/key-batches/:batch_id/keys.csv',
    operation_id: 'exportAdminKeyBatch',
    summary: 'Download the plaintext codes for a batch as CSV',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.keys.manage'],
    rate_limit: 'global',
    step_up: true,
    request: { params: z.object({ batch_id: z.uuid() }) },
    responses: {
      200: { description: 'CSV with code, display, status and redeemed_at', schema: z.string() },
    },
    errors: ['GAMES_KEYS_DISABLED', 'GAMES_KEY_BATCH_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      if (!ctx.config.features.games.keys.enabled) throw new ProblemError('GAMES_KEYS_DISABLED');
      const batch = await getKeyBatch(ctx.db, params.batch_id);
      if (!batch) throw new ProblemError('GAMES_KEY_BATCH_NOT_FOUND');
      const keys = await exportBatchKeys(ctx.db, {
        batchId: batch.id,
        encryptionKey: gamesEncryptionKey(ctx.config),
      });
      const csv = batchCsv(batch, keys, new Date());
      return new Response(csv, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="key-batch-${batch.id}.csv"`,
          'cache-control': 'no-store',
        },
      });
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/key-batches/:batch_id/revoke',
    operation_id: 'revokeAdminKeyBatch',
    summary: 'Revoke a key batch',
    description:
      'Revokes every unredeemed key in the batch. With revoke_entitlements: true it also revokes entitlements granted from this batch.',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.keys.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ batch_id: z.uuid() }),
      body: revokeBody,
    },
    responses: {
      200: {
        description: 'The revoked batch, with counts',
        schema: revokeResponseSchema,
      },
    },
    errors: ['GAMES_KEYS_DISABLED', 'GAMES_KEY_BATCH_NOT_FOUND', 'GAMES_KEY_BATCH_REVOKED'],
    handler: async ({ ctx, identity, params, body }) => {
      if (!ctx.config.features.games.keys.enabled) throw new ProblemError('GAMES_KEYS_DISABLED');
      const actorId = signedIn(identity);
      const result = await revokeKeyBatch(ctx.db, {
        batchId: params.batch_id,
        reason: body.reason,
        revokeEntitlements: body.revoke_entitlements,
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GAMES_KEY_BATCH_NOT_FOUND');
      if (result.status === 'revoked') throw new ProblemError('GAMES_KEY_BATCH_REVOKED');
      const { gameSlug, productSlug } = await resolveBatchLabels(ctx, result.result.batch);
      const summary = await getKeyBatch(ctx.db, result.result.batch.id);
      ctx.outbox.wake();
      return {
        status: 200 as const,
        body: {
          batch: batchView(
            summary ?? { ...result.result.batch, redeemed_keys: 0 },
            gameSlug,
            productSlug,
          ),
          keys_revoked: result.result.keys_revoked,
          entitlements_revoked: result.result.entitlements_revoked,
        },
      };
    },
  });
}
