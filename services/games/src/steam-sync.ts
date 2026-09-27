import { rpcRequest } from '@qtiauth/bus';
import type { EventActor } from '@qtiauth/events';
import {
  STEAM_IDENTITIES_PAGE_METHOD,
  STEAM_IDENTITIES_SERVICE,
  STEAM_LOOKUP_METHOD,
  type SteamIdentitiesPageRequest,
  steamIdentitiesPageResponseSchema,
  steamLookupResponseSchema,
} from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import type { Database, ProductsTable } from './database.ts';
import { grantEntitlement, revokeEntitlement } from './entitlements.ts';
import { SYSTEM_ACTOR } from './events.ts';
import type { Context } from './service.ts';
import type { SteamAppSettings, SteamWebClient } from './steam.ts';

export const OWNERSHIP_SYNC_REVOKE_REASON = 'steam_ownership_removed';

export type SteamLookupResult = { status: 'ok'; userId: string | null } | { status: 'unavailable' };

export async function lookupUserBySteamId(
  ctx: Context,
  steamId: string,
): Promise<SteamLookupResult> {
  const result = await rpcRequest(ctx.bus, STEAM_IDENTITIES_SERVICE, STEAM_LOOKUP_METHOD, {
    steam_id: steamId,
  });
  if (result.status !== 'ok') return { status: 'unavailable' };
  const parsed = steamLookupResponseSchema.safeParse(result.data);
  if (!parsed.success) return { status: 'unavailable' };
  return { status: 'ok', userId: parsed.data.user_id };
}

export interface SteamLinkedUser {
  steam_id: string;
  user_id: string;
}

export type SteamLinksPageResult =
  { status: 'ok'; items: SteamLinkedUser[]; next: string | null } | { status: 'unavailable' };

export async function fetchSteamLinksPage(
  ctx: Context,
  after: string | null,
  limit: number,
): Promise<SteamLinksPageResult> {
  const request: SteamIdentitiesPageRequest = { after, limit };
  const result = await rpcRequest(
    ctx.bus,
    STEAM_IDENTITIES_SERVICE,
    STEAM_IDENTITIES_PAGE_METHOD,
    request,
  );
  if (result.status !== 'ok') return { status: 'unavailable' };
  const parsed = steamIdentitiesPageResponseSchema.safeParse(result.data);
  if (!parsed.success) return { status: 'unavailable' };
  return { status: 'ok', items: parsed.data.items, next: parsed.data.next };
}

async function findBaseProduct(
  db: Kysely<Database>,
  gameId: string,
): Promise<Pick<ProductsTable, 'id' | 'game_id'> | undefined> {
  const row = await db
    .selectFrom('products')
    .select(['id', 'game_id'])
    .where('game_id', '=', gameId)
    .where('type', '=', 'base')
    .executeTakeFirst();
  return row;
}

export interface SyncUserOwnershipOptions {
  userId: string;
  steamId: string;
  apps: readonly SteamAppSettings[];
  steamClient: SteamWebClient;
  actor?: EventActor;
  now: Date;
}

export interface SyncUserOwnershipOutcome {
  granted: number;
  revoked: number;
  errors: number;
}

export async function syncUserOwnership(
  ctx: Context,
  options: SyncUserOwnershipOptions,
): Promise<SyncUserOwnershipOutcome> {
  const actor = options.actor ?? SYSTEM_ACTOR;
  let granted = 0;
  let revoked = 0;
  let errors = 0;
  for (const app of options.apps) {
    if (!app.sync_ownership) continue;
    const game = await ctx.db
      .selectFrom('games')
      .select(['id'])
      .where('slug', '=', app.game_slug)
      .executeTakeFirst();
    if (!game) continue;
    const product = await findBaseProduct(ctx.db, game.id);
    if (!product) continue;
    let ownership: Awaited<ReturnType<SteamWebClient['checkAppOwnership']>>;
    try {
      ownership = await options.steamClient.checkAppOwnership({
        steamId: options.steamId,
        appId: app.app_id,
      });
    } catch {
      errors += 1;
      continue;
    }
    if (ownership.ownsApp) {
      const result = await grantEntitlement(ctx.db, {
        userId: options.userId,
        productId: product.id,
        gameId: game.id,
        source: 'steam',
        grantedBy: null,
        expiresAt: null,
        actor,
        now: options.now,
      });
      if (result.status === 'ok' && result.changed) granted += 1;
    } else {
      const result = await revokeEntitlement(ctx.db, {
        userId: options.userId,
        productId: product.id,
        source: 'steam',
        reason: OWNERSHIP_SYNC_REVOKE_REASON,
        actor,
        now: options.now,
      });
      if (result.status === 'ok') revoked += 1;
    }
  }
  return { granted, revoked, errors };
}
