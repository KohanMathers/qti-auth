import {
  ENTITLEMENT_SOURCES,
  GAME_REVOKE_REASON_MAX,
  GAME_STATUSES,
  PRODUCT_TYPES,
} from '@qtiauth/config';
import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import {
  type GameRecord,
  getGameBySlug,
  isPublicGame,
  listGames,
  listProducts,
  type ProductRecord,
} from './catalog.ts';
import {
  grantEntitlement,
  listOwned,
  ownedGame,
  type OwnedGame,
  type OwnedProduct,
  revokeEntitlementById,
} from './entitlements.ts';
import { gamesMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { accountExists } from './users.ts';

const namePosition = z.object({ name: z.string(), id: z.uuid() });

const publicGameSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  art: z.string().nullable(),
  status: z.enum(GAME_STATUSES),
});

const ownedProductSchema = z.object({
  slug: z.string(),
  name: z.string(),
  type: z.enum(PRODUCT_TYPES),
  expires_at: z.iso.datetime().nullable(),
});

const ownedGameSchema = z.object({
  slug: z.string(),
  name: z.string(),
  status: z.enum(GAME_STATUSES),
  products: z.array(ownedProductSchema),
});

const grantBody = z.object({
  user_id: z.uuid(),
  game_slug: z.string().min(1),
  product_slug: z.string().min(1),
  expires_at: z.iso.datetime().nullable().optional(),
});

const revokeBody = z.object({
  reason: z.string().trim().min(1).max(GAME_REVOKE_REASON_MAX),
});

const grantResponseSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  game_slug: z.string(),
  product_slug: z.string(),
  source: z.enum(ENTITLEMENT_SOURCES),
  granted_by: z.string().nullable(),
  granted_at: z.iso.datetime(),
  expires_at: z.iso.datetime().nullable(),
  revoked_at: z.iso.datetime().nullable(),
  revoke_reason: z.string().nullable(),
});

export function presentedPublicGame(game: GameRecord) {
  return {
    slug: game.slug,
    name: game.name,
    description: game.description,
    icon: game.icon,
    art: game.art,
    status: game.status,
  };
}

function presentedOwned(game: OwnedGame) {
  return {
    slug: game.slug,
    name: game.name,
    status: game.status,
    products: game.products.map(presentedOwnedProduct),
  };
}

function presentedOwnedProduct(product: OwnedProduct) {
  return {
    slug: product.slug,
    name: product.name,
    type: product.type,
    expires_at: product.expires_at?.toISOString() ?? null,
  };
}

export function signedIn(identity: { sub: string | null }): string {
  if (identity.sub === null) throw new ProblemError('IDENTITY_TOKEN_INVALID');
  return identity.sub;
}

async function requirePublicGame(ctx: Context, slug: string): Promise<GameRecord> {
  const game = await getGameBySlug(ctx.db, slug);
  if (!game || !isPublicGame(game.status)) throw new ProblemError('GAMES_NOT_FOUND');
  return game;
}

async function requireProduct(
  ctx: Context,
  gameId: string,
  productSlug: string,
): Promise<ProductRecord> {
  const products = await listProducts(ctx.db, gameId);
  const product = products.find((row) => row.slug === productSlug);
  if (!product) throw new ProblemError('GAMES_PRODUCT_NOT_FOUND');
  return product;
}

export function grantResponse(record: {
  id: string;
  user_id: string;
  granted_by: string | null;
  granted_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  source: (typeof ENTITLEMENT_SOURCES)[number];
  game_slug: string;
  product_slug: string;
}) {
  return {
    id: record.id,
    user_id: record.user_id,
    game_slug: record.game_slug,
    product_slug: record.product_slug,
    source: record.source,
    granted_by: record.granted_by,
    granted_at: record.granted_at.toISOString(),
    expires_at: record.expires_at?.toISOString() ?? null,
    revoked_at: record.revoked_at?.toISOString() ?? null,
    revoke_reason: record.revoke_reason,
  };
}

export function routes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/games',
    operation_id: 'listPublicGames',
    summary: 'Public game catalog',
    tags: ['games'],
    auth: 'session',
    rate_limit: 'global',
    request: { query: paginationQuery({ defaultLimit: 25, maxLimit: 100 }) },
    responses: { 200: { description: 'Games', schema: pageSchema(publicGameSchema) } },
    handler: async ({ ctx, query }) => {
      const after = decodeCursor(namePosition, query.cursor);
      const rows = await listGames(ctx.db, {
        publicOnly: true,
        ...(after === undefined ? {} : { after }),
        limit: query.limit + 1,
      });
      const page = pageOf(rows, query.limit, (game) => ({ name: game.name, id: game.id }));
      return {
        status: 200 as const,
        body: {
          items: page.items.map(presentedPublicGame),
          next_cursor: page.next_cursor,
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/owned',
    operation_id: 'listOwnedGames',
    summary: 'Games this account owns',
    tags: ['games'],
    auth: 'session',
    rate_limit: 'global',
    request: { query: paginationQuery({ defaultLimit: 25, maxLimit: 100 }) },
    responses: { 200: { description: 'Owned games', schema: pageSchema(ownedGameSchema) } },
    handler: async ({ ctx, identity, query }) => {
      const userId = signedIn(identity);
      const after = decodeCursor(namePosition, query.cursor);
      const rows = await listOwned(ctx.db, {
        userId,
        now: new Date(),
        ...(after === undefined ? {} : { after }),
        limit: query.limit + 1,
      });
      const page = pageOf(rows, query.limit, (game) => ({ name: game.name, id: game.id }));
      return {
        status: 200 as const,
        body: {
          items: page.items.map(presentedOwned),
          next_cursor: page.next_cursor,
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug',
    operation_id: 'getPublicGame',
    summary: 'Public game detail',
    tags: ['games'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: { 200: { description: 'The game', schema: publicGameSchema } },
    errors: ['GAMES_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const game = await requirePublicGame(ctx, params.slug);
      return { status: 200 as const, body: presentedPublicGame(game) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/owned',
    operation_id: 'listOwnedProducts',
    summary: 'Products this account owns in a game',
    tags: ['games'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: {
      200: {
        description: 'Owned products',
        schema: z.object({ items: z.array(ownedProductSchema) }),
      },
    },
    errors: ['GAMES_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      const products = await ownedGame(ctx.db, { userId, gameId: game.id, now: new Date() });
      return {
        status: 200 as const,
        body: { items: products.map(presentedOwnedProduct) },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/entitlements',
    operation_id: 'grantEntitlementFromApi',
    summary: 'Grant a product to a user',
    description:
      'External grant API for payment systems and storefronts. Callers authenticate with a service token or an OAuth access token holding games.entitlements.write.',
    tags: ['games', 'intake'],
    auth: 'service',
    scopes: ['games.entitlements.write'],
    rate_limit: 'global',
    request: { body: grantBody },
    responses: { 201: { description: 'The entitlement', schema: grantResponseSchema } },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_PRODUCT_NOT_FOUND',
      'GAMES_USER_NOT_FOUND',
      'GAMES_IDENTITY_UNAVAILABLE',
      'GAMES_ENTITLEMENT_EXPIRED',
    ],
    handler: async ({ ctx, identity, body }) => {
      const game = await getGameBySlug(ctx.db, body.game_slug);
      if (!game) throw new ProblemError('GAMES_NOT_FOUND');
      const product = await requireProduct(ctx, game.id, body.product_slug);
      const status = await accountExists(ctx, body.user_id);
      if (status === 'unavailable') throw new ProblemError('GAMES_IDENTITY_UNAVAILABLE');
      if (status === 'missing') throw new ProblemError('GAMES_USER_NOT_FOUND');
      const actor = identity.client_id
        ? { type: 'service' as const, id: identity.client_id }
        : { type: 'system' as const, id: 'games' };
      const result = await grantEntitlement(ctx.db, {
        userId: body.user_id,
        productId: product.id,
        gameId: game.id,
        source: 'api',
        grantedBy: identity.client_id,
        expiresAt:
          body.expires_at === undefined || body.expires_at === null
            ? null
            : new Date(body.expires_at),
        actor,
        now: new Date(),
      });
      if (result.status === 'expired') throw new ProblemError('GAMES_ENTITLEMENT_EXPIRED');
      ctx.outbox.wake();
      if (result.changed) gamesMetrics(ctx.metrics).granted('api');
      return {
        status: 201 as const,
        body: grantResponse({
          id: result.entitlement.id,
          user_id: result.entitlement.user_id,
          granted_by: result.entitlement.granted_by,
          granted_at: result.entitlement.granted_at,
          expires_at: result.entitlement.expires_at,
          revoked_at: result.entitlement.revoked_at,
          revoke_reason: result.entitlement.revoke_reason,
          source: result.entitlement.source,
          game_slug: game.slug,
          product_slug: product.slug,
        }),
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/entitlements/:entitlement_id/revoke',
    operation_id: 'revokeEntitlementFromApi',
    summary: 'Revoke an entitlement granted through the API',
    tags: ['games', 'intake'],
    auth: 'service',
    scopes: ['games.entitlements.write'],
    rate_limit: 'global',
    request: {
      params: z.object({ entitlement_id: z.uuid() }),
      body: revokeBody,
    },
    responses: { 200: { description: 'The entitlement', schema: grantResponseSchema } },
    errors: ['GAMES_ENTITLEMENT_NOT_FOUND', 'GAMES_ENTITLEMENT_REVOKED'],
    handler: async ({ ctx, identity, params, body }) => {
      const actor = identity.client_id
        ? { type: 'service' as const, id: identity.client_id }
        : { type: 'system' as const, id: 'games' };
      const result = await revokeEntitlementById(ctx.db, {
        entitlementId: params.entitlement_id,
        reason: body.reason,
        actor,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GAMES_ENTITLEMENT_NOT_FOUND');
      if (result.status === 'revoked') throw new ProblemError('GAMES_ENTITLEMENT_REVOKED');
      const [game, product] = await Promise.all([
        ctx.db
          .selectFrom('games')
          .select(['slug'])
          .where('id', '=', result.entitlement.game_id)
          .executeTakeFirst(),
        ctx.db
          .selectFrom('products')
          .select(['slug'])
          .where('id', '=', result.entitlement.product_id)
          .executeTakeFirst(),
      ]);
      ctx.outbox.wake();
      gamesMetrics(ctx.metrics).revoked(result.entitlement.source);
      return {
        status: 200 as const,
        body: grantResponse({
          id: result.entitlement.id,
          user_id: result.entitlement.user_id,
          granted_by: result.entitlement.granted_by,
          granted_at: result.entitlement.granted_at,
          expires_at: result.entitlement.expires_at,
          revoked_at: result.entitlement.revoked_at,
          revoke_reason: result.entitlement.revoke_reason,
          source: result.entitlement.source,
          game_slug: game?.slug ?? '',
          product_slug: product?.slug ?? '',
        }),
      };
    },
  });
}
