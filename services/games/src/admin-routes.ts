import {
  ENTITLEMENT_SOURCES,
  GAME_ART_MAX,
  GAME_DESCRIPTION_MAX,
  GAME_NAME_MAX,
  GAME_REVOKE_REASON_MAX,
  GAME_SLUG,
  GAME_SLUG_MESSAGE,
  GAME_STATUSES,
  OIDC_CLIENT_NAME_MAX,
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
  createGame,
  createProduct,
  deleteGame,
  deleteProduct,
  type GameRecord,
  getGameBySlug,
  listGames,
  listProducts,
  type ProductRecord,
  setServerClient,
  updateGame,
  updateProduct,
} from './catalog.ts';
import {
  type EntitlementRecord,
  grantEntitlement,
  listEntitlements,
  revokeEntitlementById,
} from './entitlements.ts';
import { gamesMetrics } from './metrics.ts';
import { grantResponse, signedIn } from './routes.ts';
import { provisionServerClient, retireServerClient, rotateServerClient } from './server.ts';
import type { Context } from './service.ts';
import { accountExists } from './users.ts';

const productSlugParam = z.string().min(1).max(80).regex(GAME_SLUG, GAME_SLUG_MESSAGE);

const gameFields = {
  slug: z.string().regex(GAME_SLUG, GAME_SLUG_MESSAGE),
  name: z.string().min(1).max(GAME_NAME_MAX),
  description: z.string().max(GAME_DESCRIPTION_MAX),
  icon: z.string().max(GAME_ART_MAX).nullable(),
  art: z.string().max(GAME_ART_MAX).nullable(),
  status: z.enum(GAME_STATUSES),
  lease_duration_seconds: z.int().min(60).max(31_536_000).nullable(),
  cloud_save_quota_bytes: z.int().min(0).max(1_099_511_627_776).nullable(),
  steam_app_id: z.int().min(1).max(2_147_483_647).nullable(),
};

const createGameBody = z.object({
  slug: gameFields.slug,
  name: gameFields.name,
  description: gameFields.description.default(''),
  icon: gameFields.icon.default(null),
  art: gameFields.art.default(null),
  status: gameFields.status.default('draft'),
  lease_duration_seconds: gameFields.lease_duration_seconds.default(null),
  cloud_save_quota_bytes: gameFields.cloud_save_quota_bytes.default(null),
  steam_app_id: gameFields.steam_app_id.default(null),
});

const patchGameBody = z.object({
  slug: gameFields.slug.optional(),
  name: gameFields.name.optional(),
  description: gameFields.description.optional(),
  icon: gameFields.icon.optional(),
  art: gameFields.art.optional(),
  status: gameFields.status.optional(),
  lease_duration_seconds: gameFields.lease_duration_seconds.optional(),
  cloud_save_quota_bytes: gameFields.cloud_save_quota_bytes.optional(),
  steam_app_id: gameFields.steam_app_id.optional(),
});

const productBody = z.object({
  slug: productSlugParam,
  name: z.string().min(1).max(GAME_NAME_MAX),
  description: z.string().max(GAME_DESCRIPTION_MAX).default(''),
  type: z.enum(['dlc', 'edition', 'beta_access', 'soundtrack'] as const),
});

const patchProductBody = z.object({
  slug: productSlugParam.optional(),
  name: z.string().min(1).max(GAME_NAME_MAX).optional(),
  description: z.string().max(GAME_DESCRIPTION_MAX).optional(),
  type: z.enum(['dlc', 'edition', 'beta_access', 'soundtrack'] as const).optional(),
});

const grantBody = z.object({
  user_id: z.uuid(),
  expires_at: z.iso.datetime().nullable().default(null),
});

const revokeBody = z.object({
  reason: z.string().trim().min(1).max(GAME_REVOKE_REASON_MAX),
});

const adminGameSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  art: z.string().nullable(),
  status: z.enum(GAME_STATUSES),
  lease_duration_seconds: z.int().nullable(),
  cloud_save_quota_bytes: z.int().nullable(),
  steam_app_id: z.int().nullable(),
  server_client_id: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const serverCredentialSchema = z.object({
  client_id: z.string(),
  secret: z.string(),
});

const adminGameWithSecretSchema = adminGameSchema.extend({
  server_client_secret: z.string().nullable(),
});

const productSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(PRODUCT_TYPES),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const entitlementSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  game_slug: z.string(),
  product_slug: z.string(),
  source: z.enum(ENTITLEMENT_SOURCES),
  granted_by: z.uuid().nullable(),
  granted_at: z.iso.datetime(),
  expires_at: z.iso.datetime().nullable(),
  revoked_at: z.iso.datetime().nullable(),
  revoke_reason: z.string().nullable(),
});

const entitlementsQuery = paginationQuery({ defaultLimit: 25, maxLimit: 100 }).extend({
  user_id: z.uuid().optional(),
  slug: z.string().min(1).optional(),
});

const grantedPosition = z.object({ granted_at: z.iso.datetime(), id: z.uuid() });
const namePosition = z.object({ name: z.string(), id: z.uuid() });

function presentedGame(game: GameRecord) {
  return {
    id: game.id,
    slug: game.slug,
    name: game.name,
    description: game.description,
    icon: game.icon,
    art: game.art,
    status: game.status,
    lease_duration_seconds: game.lease_duration_seconds,
    cloud_save_quota_bytes: game.cloud_save_quota_bytes,
    steam_app_id: game.steam_app_id,
    server_client_id: game.server_client_id,
    created_at: game.created_at.toISOString(),
    updated_at: game.updated_at.toISOString(),
  };
}

function presentedProduct(product: ProductRecord) {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    type: product.type,
    created_at: product.created_at.toISOString(),
    updated_at: product.updated_at.toISOString(),
  };
}

function serverClientName(ctx: Context, gameName: string): string {
  const suffix = ctx.config.games.server_client_name_suffix;
  const separator = ' ';
  const base = `${gameName}${separator}${suffix}`;
  return base.length > OIDC_CLIENT_NAME_MAX ? base.slice(0, OIDC_CLIENT_NAME_MAX).trimEnd() : base;
}

async function requireGame(ctx: Context, slug: string): Promise<GameRecord> {
  const game = await getGameBySlug(ctx.db, slug);
  if (!game) throw new ProblemError('GAMES_NOT_FOUND');
  return game;
}

function catalogWriteError(status: string): never {
  if (status === 'not_found') throw new ProblemError('GAMES_NOT_FOUND');
  if (status === 'slug_taken') throw new ProblemError('GAMES_SLUG_TAKEN');
  if (status === 'base') throw new ProblemError('GAMES_PRODUCT_BASE');
  if (status === 'in_use') throw new ProblemError('GAMES_PRODUCT_IN_USE');
  throw new ProblemError('GAMES_INVALID');
}

async function entitlementView(ctx: Context, record: EntitlementRecord) {
  const [game, product] = await Promise.all([
    ctx.db.selectFrom('games').select(['slug']).where('id', '=', record.game_id).executeTakeFirst(),
    ctx.db
      .selectFrom('products')
      .select(['slug'])
      .where('id', '=', record.product_id)
      .executeTakeFirst(),
  ]);
  return {
    id: record.id,
    user_id: record.user_id,
    game_slug: game?.slug ?? '',
    product_slug: product?.slug ?? '',
    source: record.source,
    granted_by: record.granted_by,
    granted_at: record.granted_at.toISOString(),
    expires_at: record.expires_at?.toISOString() ?? null,
    revoked_at: record.revoked_at?.toISOString() ?? null,
    revoke_reason: record.revoke_reason,
  };
}

export function adminRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/games',
    operation_id: 'listAdminGames',
    summary: 'All games, including drafts and hidden',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.catalog.manage'],
    rate_limit: 'global',
    request: {
      query: paginationQuery({ defaultLimit: 25, maxLimit: 100 }).extend({
        status: z.enum(GAME_STATUSES).optional(),
      }),
    },
    responses: { 200: { description: 'Games', schema: pageSchema(adminGameSchema) } },
    handler: async ({ ctx, query }) => {
      const after = decodeCursor(namePosition, query.cursor);
      const rows = await listGames(ctx.db, {
        publicOnly: false,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(after === undefined ? {} : { after }),
        limit: query.limit + 1,
      });
      const page = pageOf(rows, query.limit, (game) => ({ name: game.name, id: game.id }));
      return {
        status: 200 as const,
        body: {
          items: page.items.map(presentedGame),
          next_cursor: page.next_cursor,
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/games',
    operation_id: 'createAdminGame',
    summary: 'Create a game',
    description:
      'Also creates the base product and a confidential server client, whose secret is returned once here and never again.',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.catalog.manage'],
    rate_limit: 'global',
    request: { body: createGameBody },
    responses: {
      201: {
        description: 'The game with its server client credentials',
        schema: adminGameWithSecretSchema,
      },
    },
    errors: ['GAMES_SLUG_TAKEN', 'GAMES_INVALID', 'GAMES_SERVER_UNAVAILABLE'],
    handler: async ({ ctx, identity, body }) => {
      const actorId = signedIn(identity);
      const now = new Date();
      const created = await createGame(ctx.db, {
        slug: body.slug,
        name: body.name,
        description: body.description,
        icon: body.icon,
        art: body.art,
        status: body.status,
        lease_duration_seconds: body.lease_duration_seconds,
        cloud_save_quota_bytes: body.cloud_save_quota_bytes,
        steam_app_id: body.steam_app_id,
        actor: { type: 'user', id: actorId },
        now,
      });
      if (created.status !== 'ok') catalogWriteError(created.status);
      const provision = await provisionServerClient(ctx, {
        gameId: created.game.id,
        name: serverClientName(ctx, created.game.name),
        actor: { type: 'user', id: actorId },
      });
      if (provision === undefined) throw new ProblemError('GAMES_SERVER_UNAVAILABLE');
      await setServerClient(ctx.db, {
        gameId: created.game.id,
        clientId: provision.client_id,
        now,
      });
      ctx.outbox.wake();
      const secret = provision.status === 'ok' ? provision.secret : null;
      return {
        status: 201 as const,
        body: {
          ...presentedGame({
            ...created.game,
            server_client_id: provision.client_id,
            updated_at: now,
          }),
          server_client_secret: secret,
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/games/:slug',
    operation_id: 'getAdminGame',
    summary: 'Admin game detail',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.catalog.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: { 200: { description: 'The game', schema: adminGameSchema } },
    errors: ['GAMES_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const game = await requireGame(ctx, params.slug);
      return { status: 200 as const, body: presentedGame(game) };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/admin/games/:slug',
    operation_id: 'updateAdminGame',
    summary: 'Update a game',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.catalog.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }), body: patchGameBody },
    responses: { 200: { description: 'The game', schema: adminGameSchema } },
    errors: ['GAMES_NOT_FOUND', 'GAMES_SLUG_TAKEN', 'GAMES_INVALID'],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const result = await updateGame(ctx.db, {
        currentSlug: params.slug,
        actor: { type: 'user', id: actorId },
        now: new Date(),
        ...(body.slug === undefined ? {} : { slug: body.slug }),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.icon === undefined ? {} : { icon: body.icon }),
        ...(body.art === undefined ? {} : { art: body.art }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.lease_duration_seconds === undefined
          ? {}
          : { lease_duration_seconds: body.lease_duration_seconds }),
        ...(body.cloud_save_quota_bytes === undefined
          ? {}
          : { cloud_save_quota_bytes: body.cloud_save_quota_bytes }),
        ...(body.steam_app_id === undefined ? {} : { steam_app_id: body.steam_app_id }),
      });
      if (result.status !== 'ok') catalogWriteError(result.status);
      ctx.outbox.wake();
      return { status: 200 as const, body: presentedGame(result.game) };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/games/:slug',
    operation_id: 'deleteAdminGame',
    summary: 'Delete a game and its products',
    description: 'Also retires the game server client.',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.catalog.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: { 204: { description: 'Deleted' } },
    errors: ['GAMES_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      await retireServerClient(ctx, {
        gameId: game.id,
        actor: { type: 'user', id: actorId },
      });
      const removed = await deleteGame(ctx.db, {
        gameId: game.id,
        actor: { type: 'user', id: actorId },
      });
      if (!removed) throw new ProblemError('GAMES_NOT_FOUND');
      ctx.outbox.wake();
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/games/:slug/server-client/rotate',
    operation_id: 'rotateGameServerClient',
    summary: 'Rotate the game server client secret',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.catalog.manage'],
    rate_limit: 'global',
    step_up: true,
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: {
      200: { description: 'The new server client credentials', schema: serverCredentialSchema },
    },
    errors: ['GAMES_NOT_FOUND', 'GAMES_SERVER_UNAVAILABLE'],
    handler: async ({ ctx, identity, params }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const result = await rotateServerClient(ctx, {
        gameId: game.id,
        actor: { type: 'user', id: actorId },
      });
      if (result === 'missing') {
        const provision = await provisionServerClient(ctx, {
          gameId: game.id,
          name: serverClientName(ctx, game.name),
          actor: { type: 'user', id: actorId },
        });
        if (provision?.status !== 'ok') throw new ProblemError('GAMES_SERVER_UNAVAILABLE');
        await setServerClient(ctx.db, {
          gameId: game.id,
          clientId: provision.client_id,
          now: new Date(),
        });
        return {
          status: 200 as const,
          body: { client_id: provision.client_id, secret: provision.secret },
        };
      }
      if (result === undefined) throw new ProblemError('GAMES_SERVER_UNAVAILABLE');
      return {
        status: 200 as const,
        body: { client_id: result.client_id, secret: result.secret },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/games/:slug/products',
    operation_id: 'listAdminProducts',
    summary: 'Products for a game',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.catalog.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: {
      200: {
        description: 'Products',
        schema: z.object({ items: z.array(productSchema) }),
      },
    },
    errors: ['GAMES_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const game = await requireGame(ctx, params.slug);
      const products = await listProducts(ctx.db, game.id);
      return {
        status: 200 as const,
        body: { items: products.map(presentedProduct) },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/games/:slug/products',
    operation_id: 'createAdminProduct',
    summary: 'Create a product',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.catalog.manage'],
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }), body: productBody },
    responses: { 201: { description: 'The product', schema: productSchema } },
    errors: ['GAMES_NOT_FOUND', 'GAMES_SLUG_TAKEN', 'GAMES_INVALID', 'GAMES_PRODUCT_BASE'],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const result = await createProduct(ctx.db, {
        gameId: game.id,
        slug: body.slug,
        name: body.name,
        description: body.description,
        type: body.type,
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status !== 'ok') catalogWriteError(result.status);
      ctx.outbox.wake();
      return { status: 201 as const, body: presentedProduct(result.product) };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/admin/games/:slug/products/:product_slug',
    operation_id: 'updateAdminProduct',
    summary: 'Update a product',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.catalog.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), product_slug: z.string().min(1) }),
      body: patchProductBody,
    },
    responses: { 200: { description: 'The product', schema: productSchema } },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_PRODUCT_NOT_FOUND',
      'GAMES_SLUG_TAKEN',
      'GAMES_INVALID',
      'GAMES_PRODUCT_BASE',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const result = await updateProduct(ctx.db, {
        gameId: game.id,
        slug: params.product_slug,
        ...(body.slug === undefined ? {} : { nextSlug: body.slug }),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.type === undefined ? {} : { type: body.type }),
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GAMES_PRODUCT_NOT_FOUND');
      if (result.status !== 'ok') catalogWriteError(result.status);
      ctx.outbox.wake();
      return { status: 200 as const, body: presentedProduct(result.product) };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/games/:slug/products/:product_slug',
    operation_id: 'deleteAdminProduct',
    summary: 'Delete a product',
    description: 'The base product stays with the game and cannot be deleted.',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.catalog.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), product_slug: z.string().min(1) }),
    },
    responses: { 204: { description: 'Deleted' } },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_PRODUCT_NOT_FOUND',
      'GAMES_PRODUCT_BASE',
      'GAMES_PRODUCT_IN_USE',
    ],
    handler: async ({ ctx, identity, params }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const result = await deleteProduct(ctx.db, {
        gameId: game.id,
        slug: params.product_slug,
        actor: { type: 'user', id: actorId },
      });
      if (result.status === 'not_found') throw new ProblemError('GAMES_PRODUCT_NOT_FOUND');
      if (result.status !== 'ok') catalogWriteError(result.status);
      ctx.outbox.wake();
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/entitlements',
    operation_id: 'listAdminEntitlements',
    summary: 'Entitlements across every game',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.entitlements.manage'],
    rate_limit: 'global',
    request: { query: entitlementsQuery },
    responses: {
      200: { description: 'Entitlements', schema: pageSchema(entitlementSchema) },
    },
    handler: async ({ ctx, query }) => {
      const after = decodeCursor(grantedPosition, query.cursor);
      let gameId: string | undefined;
      if (query.slug !== undefined) {
        const game = await getGameBySlug(ctx.db, query.slug);
        if (!game) {
          return { status: 200 as const, body: { items: [], next_cursor: null } };
        }
        gameId = game.id;
      }
      const rows = await listEntitlements(ctx.db, {
        ...(gameId === undefined ? {} : { gameId }),
        ...(query.user_id === undefined ? {} : { userId: query.user_id }),
        ...(after === undefined ? {} : { after }),
        limit: query.limit + 1,
      });
      const page = pageOf(rows, query.limit, (row) => ({
        granted_at: row.granted_at.toISOString(),
        id: row.id,
      }));
      const items = await Promise.all(page.items.map((row) => entitlementView(ctx, row)));
      return {
        status: 200 as const,
        body: { items, next_cursor: page.next_cursor },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/games/:slug/products/:product_slug/entitlements',
    operation_id: 'grantAdminEntitlement',
    summary: 'Grant a product to a user',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.entitlements.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), product_slug: z.string().min(1) }),
      body: grantBody,
    },
    responses: { 201: { description: 'The entitlement', schema: entitlementSchema } },
    errors: [
      'GAMES_NOT_FOUND',
      'GAMES_PRODUCT_NOT_FOUND',
      'GAMES_USER_NOT_FOUND',
      'GAMES_IDENTITY_UNAVAILABLE',
      'GAMES_ENTITLEMENT_EXPIRED',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const game = await requireGame(ctx, params.slug);
      const products = await listProducts(ctx.db, game.id);
      const product = products.find((row) => row.slug === params.product_slug);
      if (!product) throw new ProblemError('GAMES_PRODUCT_NOT_FOUND');
      const status = await accountExists(ctx, body.user_id);
      if (status === 'unavailable') throw new ProblemError('GAMES_IDENTITY_UNAVAILABLE');
      if (status === 'missing') throw new ProblemError('GAMES_USER_NOT_FOUND');
      const result = await grantEntitlement(ctx.db, {
        userId: body.user_id,
        productId: product.id,
        gameId: game.id,
        source: 'admin_grant',
        grantedBy: actorId,
        expiresAt: body.expires_at === null ? null : new Date(body.expires_at),
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status === 'expired') throw new ProblemError('GAMES_ENTITLEMENT_EXPIRED');
      ctx.outbox.wake();
      if (result.changed) gamesMetrics(ctx.metrics).granted('admin_grant');
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
    path: '/api/v1/admin/entitlements/:entitlement_id/revoke',
    operation_id: 'revokeAdminEntitlement',
    summary: 'Revoke an entitlement',
    tags: ['games', 'admin'],
    auth: 'session',
    permissions: ['games.entitlements.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ entitlement_id: z.uuid() }),
      body: revokeBody,
    },
    responses: { 200: { description: 'The entitlement', schema: entitlementSchema } },
    errors: ['GAMES_ENTITLEMENT_NOT_FOUND', 'GAMES_ENTITLEMENT_REVOKED'],
    handler: async ({ ctx, identity, params, body }) => {
      const actorId = signedIn(identity);
      const result = await revokeEntitlementById(ctx.db, {
        entitlementId: params.entitlement_id,
        reason: body.reason,
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GAMES_ENTITLEMENT_NOT_FOUND');
      if (result.status === 'revoked') throw new ProblemError('GAMES_ENTITLEMENT_REVOKED');
      ctx.outbox.wake();
      gamesMetrics(ctx.metrics).revoked(result.entitlement.source);
      return {
        status: 200 as const,
        body: await entitlementView(ctx, result.entitlement),
      };
    },
  });
}
