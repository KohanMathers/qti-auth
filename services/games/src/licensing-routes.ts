import { GAME_REVOKE_REASON_MAX } from '@qtiauth/config';
import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import { getGameBySlug } from './catalog.ts';
import {
  hashDeviceId,
  issueLease,
  type LeaseRecord,
  listLeases,
  listRevocations,
  revokeLease,
  signLease,
  touchLease,
  verifyLeaseWithKeyring,
} from './licensing.ts';
import type { Keyring } from './licensing-keys.ts';
import { keyringOf } from './licensing-keys.ts';
import { gamesMetrics } from './metrics.ts';
import { requirePublicGame } from './route-helpers.ts';
import { signedIn } from './routes.ts';
import type { Context } from './service.ts';
import {
  LICENSE_KEYS_PATH,
  leaseDurationMs,
  LICENSING_ISSUER,
  REVOCATION_LIST_LIMIT,
} from './settings.ts';

const issueBody = z.object({
  device_id: z.string().trim().min(1).max(200).nullable().default(null),
  device_label: z.string().trim().min(1).max(80).nullable().default(null),
});

const verifyBody = z.object({
  token: z.string().min(1),
  device_id: z.string().trim().min(1).max(200).nullable().default(null),
});

const revokeBody = z.object({
  reason: z.string().trim().min(1).max(GAME_REVOKE_REASON_MAX),
});

const leaseProductSchema = z.object({
  slug: z.string(),
  type: z.string(),
  expires_at: z.iso.datetime().nullable(),
});

const leaseIssueResponseSchema = z.object({
  lease_id: z.uuid(),
  token: z.string(),
  game_slug: z.string(),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  device_bound: z.boolean(),
  device_label: z.string().nullable(),
  products: z.array(leaseProductSchema),
});

const leaseVerifyResponseSchema = z.object({
  valid: z.boolean(),
  reason: z.string().nullable(),
  lease_id: z.uuid().nullable(),
  user_id: z.uuid().nullable(),
  game_slug: z.string().nullable(),
  expires_at: z.iso.datetime().nullable(),
  products: z.array(leaseProductSchema).nullable(),
});

const revocationEntrySchema = z.object({
  jti: z.uuid(),
  game_slug: z.string(),
  revoked_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
});

const revocationListSchema = z.object({
  iss: z.string(),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  game_slug: z.string().nullable(),
  since: z.iso.datetime().nullable(),
  revocations: z.array(revocationEntrySchema),
  token: z.string(),
});

const deviceSchema = z.object({
  lease_id: z.uuid(),
  device_label: z.string().nullable(),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  last_seen_at: z.iso.datetime().nullable(),
});

const adminLeaseSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  game_slug: z.string(),
  device_label: z.string().nullable(),
  device_bound: z.boolean(),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  revoked_at: z.iso.datetime().nullable(),
  revoke_reason: z.string().nullable(),
  last_seen_at: z.iso.datetime().nullable(),
  product_slugs: z.array(z.string()),
});

const issuedPosition = z.object({ issued_at: z.iso.datetime(), id: z.uuid() });

function requireLicensingEnabled(ctx: Context): void {
  if (!ctx.config.features.games.licensing.enabled) {
    throw new ProblemError('GAMES_LICENSING_DISABLED');
  }
}

function requireKeyring(ctx: Context): Keyring {
  const keyring = keyringOf(ctx);
  if (!keyring) throw new ProblemError('GAMES_LICENSING_KEY_UNAVAILABLE');
  return keyring;
}

function adminLeaseView(lease: LeaseRecord, gameSlug: string): z.output<typeof adminLeaseSchema> {
  return {
    id: lease.id,
    user_id: lease.user_id,
    game_slug: gameSlug,
    device_label: lease.device_label,
    device_bound: lease.device_hash !== null,
    issued_at: lease.issued_at.toISOString(),
    expires_at: lease.expires_at.toISOString(),
    revoked_at: lease.revoked_at?.toISOString() ?? null,
    revoke_reason: lease.revoke_reason,
    last_seen_at: lease.last_seen_at?.toISOString() ?? null,
    product_slugs: lease.products.map((product) => product.slug),
  };
}

function deviceView(lease: LeaseRecord): z.output<typeof deviceSchema> {
  return {
    lease_id: lease.id,
    device_label: lease.device_label,
    issued_at: lease.issued_at.toISOString(),
    expires_at: lease.expires_at.toISOString(),
    last_seen_at: lease.last_seen_at?.toISOString() ?? null,
  };
}

async function resolveGameSlugs(
  ctx: Context,
  gameIds: readonly string[],
): Promise<Map<string, string>> {
  if (gameIds.length === 0) return new Map();
  const rows = await ctx.db
    .selectFrom('games')
    .select(['id', 'slug'])
    .where('id', 'in', [...new Set(gameIds)])
    .execute();
  return new Map(rows.map((row) => [row.id, row.slug]));
}

export function licensingRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: LICENSE_KEYS_PATH,
    operation_id: 'listLicenseKeys',
    summary: 'Public licence signing keys',
    description:
      'JWKS of dedicated licence signing keys. Game clients bundle these to verify lease tokens offline.',
    tags: ['games', 'licensing'],
    auth: 'none',
    rate_limit: 'global',
    responses: { 200: { description: 'Licence JWKS' } },
    errors: ['GAMES_LICENSING_DISABLED'],
    handler: async ({ ctx }) => {
      requireLicensingEnabled(ctx);
      const keyring = keyringOf(ctx);
      const body = keyring ? await keyring.jwks() : { keys: [] };
      return Response.json(body, {
        headers: {
          'cache-control': 'public, max-age=300',
          'content-type': 'application/jwk-set+json',
        },
      });
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/:slug/licensing/leases',
    operation_id: 'issueGameLicenseLease',
    summary: 'Issue an offline licence lease for a game',
    description:
      'Signs a lease listing every owned product for the game. Games with device binding require device_id, and each user has at most licensing.max_devices concurrent leases.',
    tags: ['games', 'licensing'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }), body: issueBody },
    responses: { 201: { description: 'The signed lease', schema: leaseIssueResponseSchema } },
    errors: [
      'GAMES_LICENSING_DISABLED',
      'GAMES_NOT_FOUND',
      'GAMES_LICENSING_NOT_OWNED',
      'GAMES_LICENSING_DEVICE_REQUIRED',
      'GAMES_LICENSING_DEVICE_LIMIT',
      'GAMES_LICENSING_KEY_UNAVAILABLE',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      requireLicensingEnabled(ctx);
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      const keyring = requireKeyring(ctx);
      const now = new Date();
      const outcome = await issueLease(ctx.db, {
        userId,
        gameId: game.id,
        gameSlug: game.slug,
        deviceBinding: game.licensing_device_binding,
        deviceId: body.device_id,
        deviceLabel: body.device_label,
        maxDevices: ctx.config.games.licensing.max_devices,
        duration: leaseDurationMs(ctx.config, game),
        actor: { type: 'user', id: userId },
        now,
      });
      const metrics = gamesMetrics(ctx.metrics);
      metrics.licenseIssued(outcome.status);
      if (outcome.status === 'not_owned') throw new ProblemError('GAMES_LICENSING_NOT_OWNED');
      if (outcome.status === 'device_required') {
        throw new ProblemError('GAMES_LICENSING_DEVICE_REQUIRED');
      }
      if (outcome.status === 'device_limit') throw new ProblemError('GAMES_LICENSING_DEVICE_LIMIT');
      const lease = outcome.lease;
      const signing = keyring.signingKey();
      const token = signLease(
        {
          jti: lease.id,
          iss: LICENSING_ISSUER,
          sub: lease.user_id,
          aud: game.slug,
          iat: Math.floor(lease.issued_at.getTime() / 1_000),
          exp: Math.floor(lease.expires_at.getTime() / 1_000),
          game_slug: game.slug,
          products: lease.products,
          device_hash: lease.device_hash,
        },
        {
          alg: ctx.config.games.licensing.signing.algorithm,
          kid: signing.kid,
          privateKey: signing.privateKey,
        },
      );
      ctx.outbox.wake();
      return {
        status: 201 as const,
        body: {
          lease_id: lease.id,
          token,
          game_slug: game.slug,
          issued_at: lease.issued_at.toISOString(),
          expires_at: lease.expires_at.toISOString(),
          device_bound: lease.device_hash !== null,
          device_label: lease.device_label,
          products: lease.products.map((product) => ({
            slug: product.slug,
            type: product.type,
            expires_at: product.expires_at,
          })),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/games/licensing/verify',
    operation_id: 'verifyGameLicenseLease',
    summary: 'Online lease verification',
    description:
      'For game servers that prefer an online check. Fully signature-verified, and cross-checked against the revocation list. No authentication required.',
    tags: ['games', 'licensing'],
    auth: 'none',
    rate_limit: 'global',
    request: { body: verifyBody },
    responses: {
      200: { description: 'Whether the lease is valid', schema: leaseVerifyResponseSchema },
    },
    errors: ['GAMES_LICENSING_DISABLED', 'GAMES_LICENSING_KEY_UNAVAILABLE'],
    handler: async ({ ctx, body }) => {
      requireLicensingEnabled(ctx);
      const keyring = requireKeyring(ctx);
      const metrics = gamesMetrics(ctx.metrics);
      const fullyVerified = await verifyLeaseWithKeyring(body.token, keyring, {
        issuer: LICENSING_ISSUER,
      });
      if (fullyVerified === undefined) {
        metrics.licenseVerified('invalid');
        return {
          status: 200 as const,
          body: {
            valid: false,
            reason: 'invalid_signature',
            lease_id: null,
            user_id: null,
            game_slug: null,
            expires_at: null,
            products: null,
          },
        };
      }
      const payload = fullyVerified.payload;
      const stored = await ctx.db
        .selectFrom('license_leases')
        .selectAll()
        .where('id', '=', payload.jti)
        .executeTakeFirst();
      if (!stored) {
        metrics.licenseVerified('invalid');
        return {
          status: 200 as const,
          body: {
            valid: false,
            reason: 'unknown_lease',
            lease_id: payload.jti,
            user_id: payload.sub,
            game_slug: payload.game_slug,
            expires_at: new Date(payload.exp * 1_000).toISOString(),
            products: payload.products,
          },
        };
      }
      if (stored.revoked_at !== null) {
        metrics.licenseVerified('revoked');
        return {
          status: 200 as const,
          body: {
            valid: false,
            reason: 'revoked',
            lease_id: stored.id,
            user_id: stored.user_id,
            game_slug: payload.game_slug,
            expires_at: stored.expires_at.toISOString(),
            products: payload.products,
          },
        };
      }
      if (
        payload.device_hash !== null &&
        body.device_id !== null &&
        hashDeviceId(body.device_id) !== payload.device_hash
      ) {
        metrics.licenseVerified('invalid');
        return {
          status: 200 as const,
          body: {
            valid: false,
            reason: 'device_mismatch',
            lease_id: stored.id,
            user_id: stored.user_id,
            game_slug: payload.game_slug,
            expires_at: stored.expires_at.toISOString(),
            products: payload.products,
          },
        };
      }
      await touchLease(ctx.db, { leaseId: stored.id, now: new Date() });
      metrics.licenseVerified('valid');
      return {
        status: 200 as const,
        body: {
          valid: true,
          reason: null,
          lease_id: stored.id,
          user_id: stored.user_id,
          game_slug: payload.game_slug,
          expires_at: stored.expires_at.toISOString(),
          products: payload.products,
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/licensing/revocations',
    operation_id: 'listGameLicenseRevocations',
    summary: 'Signed revocation list',
    description:
      'Returns revoked lease jti values so occasionally-online servers can pull them in bulk. The response body is signed with the active licence key.',
    tags: ['games', 'licensing'],
    auth: 'none',
    rate_limit: 'global',
    request: {
      query: z.object({
        since: z.iso.datetime().optional(),
        game_slug: z.string().min(1).optional(),
      }),
    },
    responses: { 200: { description: 'The signed revocation list', schema: revocationListSchema } },
    errors: ['GAMES_LICENSING_DISABLED', 'GAMES_LICENSING_KEY_UNAVAILABLE', 'GAMES_NOT_FOUND'],
    handler: async ({ ctx, query }) => {
      requireLicensingEnabled(ctx);
      const keyring = requireKeyring(ctx);
      let gameId: string | undefined;
      let gameSlug: string | null = null;
      if (query.game_slug !== undefined) {
        const game = await getGameBySlug(ctx.db, query.game_slug);
        if (!game) throw new ProblemError('GAMES_NOT_FOUND');
        gameId = game.id;
        gameSlug = game.slug;
      }
      const now = new Date();
      const since = query.since === undefined ? null : new Date(query.since);
      const rows = await listRevocations(ctx.db, {
        ...(gameId === undefined ? {} : { gameId }),
        since,
        now,
        limit: REVOCATION_LIST_LIMIT,
      });
      const slugs = await resolveGameSlugs(
        ctx,
        rows.map((row) => row.game_id),
      );
      const issuedAt = Math.floor(now.getTime() / 1_000);
      const expiresAt =
        issuedAt + Math.floor(ctx.config.games.licensing.revocation_list_ttl / 1_000);
      const signing = keyring.signingKey();
      const revocations = rows.map((row) => ({
        jti: row.jti,
        game_slug: slugs.get(row.game_id) ?? '',
        revoked_at: Math.floor(row.revoked_at.getTime() / 1_000),
        expires_at: Math.floor(row.expires_at.getTime() / 1_000),
      }));
      const token = signLease(
        {
          jti: `revocations-${signing.kid}-${issuedAt.toString(36)}`,
          iss: LICENSING_ISSUER,
          sub: 'revocations',
          aud: gameSlug ?? '*',
          iat: issuedAt,
          exp: expiresAt,
          game_slug: gameSlug ?? '*',
          products: [],
          device_hash: null,
        },
        {
          alg: ctx.config.games.licensing.signing.algorithm,
          kid: signing.kid,
          privateKey: signing.privateKey,
        },
      );
      return {
        status: 200 as const,
        body: {
          iss: LICENSING_ISSUER,
          issued_at: new Date(issuedAt * 1_000).toISOString(),
          expires_at: new Date(expiresAt * 1_000).toISOString(),
          game_slug: gameSlug,
          since: since?.toISOString() ?? null,
          revocations: revocations.map((row) => ({
            jti: row.jti,
            game_slug: row.game_slug,
            revoked_at: new Date(row.revoked_at * 1_000).toISOString(),
            expires_at: new Date(row.expires_at * 1_000).toISOString(),
          })),
          token,
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/:slug/licensing/devices',
    operation_id: 'listGameLicenseDevices',
    summary: 'Devices bound to your leases for a game',
    tags: ['games', 'licensing'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ slug: z.string().min(1) }) },
    responses: {
      200: { description: 'Bound devices', schema: z.object({ items: z.array(deviceSchema) }) },
    },
    errors: ['GAMES_LICENSING_DISABLED', 'GAMES_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      requireLicensingEnabled(ctx);
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      const now = new Date();
      const rows = await listLeases(ctx.db, {
        userId,
        gameId: game.id,
        activeOnly: true,
        limit: ctx.config.games.licensing.max_devices + 1,
        now,
      });
      return {
        status: 200 as const,
        body: { items: rows.filter((lease) => lease.device_hash !== null).map(deviceView) },
      };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/games/:slug/licensing/devices/:lease_id',
    operation_id: 'revokeGameLicenseDevice',
    summary: 'Revoke one of your device leases',
    tags: ['games', 'licensing'],
    auth: 'session',
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1), lease_id: z.uuid() }),
    },
    responses: { 204: { description: 'Revoked' } },
    errors: [
      'GAMES_LICENSING_DISABLED',
      'GAMES_NOT_FOUND',
      'GAMES_LICENSING_LEASE_NOT_FOUND',
      'GAMES_LICENSING_LEASE_REVOKED',
    ],
    handler: async ({ ctx, identity, params }) => {
      requireLicensingEnabled(ctx);
      const userId = signedIn(identity);
      const game = await requirePublicGame(ctx, params.slug);
      const lease = await ctx.db
        .selectFrom('license_leases')
        .select(['user_id', 'game_id'])
        .where('id', '=', params.lease_id)
        .executeTakeFirst();
      if (lease?.user_id !== userId || lease.game_id !== game.id) {
        throw new ProblemError('GAMES_LICENSING_LEASE_NOT_FOUND');
      }
      const result = await revokeLease(ctx.db, {
        leaseId: params.lease_id,
        reason: 'user_revoked',
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GAMES_LICENSING_LEASE_NOT_FOUND');
      if (result.status === 'revoked') throw new ProblemError('GAMES_LICENSING_LEASE_REVOKED');
      gamesMetrics(ctx.metrics).licenseRevoked();
      ctx.outbox.wake();
      return new Response(null, { status: 204 });
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/games/:slug/licenses',
    operation_id: 'listAdminGameLicenses',
    summary: 'Licence leases for a game',
    tags: ['games', 'admin', 'licensing'],
    auth: 'session',
    permissions: ['games.licensing.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ slug: z.string().min(1) }),
      query: paginationQuery({ defaultLimit: 25, maxLimit: 100 }),
    },
    responses: { 200: { description: 'Leases', schema: pageSchema(adminLeaseSchema) } },
    errors: ['GAMES_LICENSING_DISABLED', 'GAMES_NOT_FOUND'],
    handler: async ({ ctx, params, query }) => {
      requireLicensingEnabled(ctx);
      const game = await getGameBySlug(ctx.db, params.slug);
      if (!game) throw new ProblemError('GAMES_NOT_FOUND');
      const after = decodeCursor(issuedPosition, query.cursor);
      const rows = await listLeases(ctx.db, {
        gameId: game.id,
        ...(after === undefined ? {} : { after }),
        limit: query.limit + 1,
        now: new Date(),
      });
      const page = pageOf(rows, query.limit, (lease) => ({
        issued_at: lease.issued_at.toISOString(),
        id: lease.id,
      }));
      return {
        status: 200 as const,
        body: {
          items: page.items.map((lease) => adminLeaseView(lease, game.slug)),
          next_cursor: page.next_cursor,
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/licenses/:lease_id/revoke',
    operation_id: 'revokeAdminGameLicense',
    summary: 'Revoke a licence lease',
    tags: ['games', 'admin', 'licensing'],
    auth: 'session',
    permissions: ['games.licensing.manage'],
    rate_limit: 'global',
    request: { params: z.object({ lease_id: z.uuid() }), body: revokeBody },
    responses: { 200: { description: 'The revoked lease', schema: adminLeaseSchema } },
    errors: [
      'GAMES_LICENSING_DISABLED',
      'GAMES_LICENSING_LEASE_NOT_FOUND',
      'GAMES_LICENSING_LEASE_REVOKED',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      requireLicensingEnabled(ctx);
      const actorId = signedIn(identity);
      const result = await revokeLease(ctx.db, {
        leaseId: params.lease_id,
        reason: body.reason,
        actor: { type: 'user', id: actorId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GAMES_LICENSING_LEASE_NOT_FOUND');
      if (result.status === 'revoked') throw new ProblemError('GAMES_LICENSING_LEASE_REVOKED');
      const slugs = await resolveGameSlugs(ctx, [result.lease.game_id]);
      gamesMetrics(ctx.metrics).licenseRevoked();
      ctx.outbox.wake();
      return {
        status: 200 as const,
        body: adminLeaseView(result.lease, slugs.get(result.lease.game_id) ?? ''),
      };
    },
  });
}
