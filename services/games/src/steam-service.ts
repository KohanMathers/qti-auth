import type { GameRecord } from './catalog.ts';
import { grantEntitlement } from './entitlements.ts';
import { SYSTEM_ACTOR } from './events.ts';
import type { Context } from './service.ts';
import {
  familySharingAllows,
  type SteamAppSettings,
  SteamApiError,
  type SteamWebClient,
} from './steam.ts';
import { steamClientOf } from './steam-state.ts';
import { lookupUserBySteamId } from './steam-sync.ts';

export type SteamAuthMetric =
  | 'ok_linked_entitled'
  | 'ok_linked_unentitled'
  | 'ok_unlinked'
  | 'ticket_rejected'
  | 'family_denied'
  | 'steam_unavailable';

export type SteamAuthOutcome =
  | {
      status: 'ok';
      steamId: string;
      ownerSteamId: string;
      familyShared: boolean;
      vacBanned: boolean;
      publisherBanned: boolean;
      userId: string | null;
      entitled: boolean;
      deviceCode: string | null;
      metric: SteamAuthMetric;
    }
  | { status: 'ticket_rejected'; metric: 'ticket_rejected' }
  | { status: 'family_denied'; metric: 'family_denied' }
  | { status: 'steam_unavailable'; metric: 'steam_unavailable' };

export interface SteamAuthOptions {
  app: SteamAppSettings;
  game: GameRecord;
  ticket: string;
  issueTokens: boolean;
  now: Date;
}

async function findBaseProductId(ctx: Context, gameId: string): Promise<string | undefined> {
  const row = await ctx.db
    .selectFrom('products')
    .select(['id'])
    .where('game_id', '=', gameId)
    .where('type', '=', 'base')
    .executeTakeFirst();
  return row?.id;
}

async function grantOwnership(
  ctx: Context,
  options: { userId: string; gameId: string; now: Date },
): Promise<boolean> {
  const productId = await findBaseProductId(ctx, options.gameId);
  if (productId === undefined) return false;
  const result = await grantEntitlement(ctx.db, {
    userId: options.userId,
    productId,
    gameId: options.gameId,
    source: 'steam',
    grantedBy: null,
    expiresAt: null,
    actor: SYSTEM_ACTOR,
    now: options.now,
  });
  return result.status === 'ok';
}

export async function steamAuthOutcomeFor(
  ctx: Context,
  options: SteamAuthOptions,
  client: SteamWebClient = steamClientOf(ctx),
): Promise<SteamAuthOutcome> {
  let ticketResult: Awaited<ReturnType<SteamWebClient['authenticateTicket']>>;
  try {
    ticketResult = await client.authenticateTicket({
      appId: options.app.app_id,
      ticket: options.ticket,
      identity: options.app.ticket_identity,
    });
  } catch (error) {
    if (error instanceof SteamApiError) {
      return { status: 'steam_unavailable' as const, metric: 'steam_unavailable' as const };
    }
    throw error;
  }
  if (ticketResult.status === 'rejected') {
    return { status: 'ticket_rejected' as const, metric: 'ticket_rejected' as const };
  }
  const familyShared = ticketResult.steamId !== ticketResult.ownerSteamId;
  const familyDecision = familySharingAllows(options.app.family_sharing, { familyShared });
  if (!familyDecision.allowed) {
    return { status: 'family_denied' as const, metric: 'family_denied' as const };
  }
  const lookup = await lookupUserBySteamId(ctx, ticketResult.steamId);
  const userId = lookup.status === 'ok' ? lookup.userId : null;
  let entitled = false;
  if (familyDecision.grantEntitlement && userId !== null && options.app.sync_ownership) {
    try {
      const ownership = await client.checkAppOwnership({
        steamId: ticketResult.ownerSteamId,
        appId: options.app.app_id,
      });
      if (ownership.ownsApp) {
        entitled = await grantOwnership(ctx, {
          userId,
          gameId: options.game.id,
          now: options.now,
        });
      }
    } catch (error) {
      if (!(error instanceof SteamApiError)) throw error;
      ctx.log.warn('steam ownership check failed; treating as unentitled', {
        app_id: options.app.app_id,
        code: error.code,
      });
    }
  }
  let metric: SteamAuthMetric;
  if (userId === null) metric = 'ok_unlinked';
  else if (entitled) metric = 'ok_linked_entitled';
  else metric = 'ok_linked_unentitled';
  return {
    status: 'ok' as const,
    steamId: ticketResult.steamId,
    ownerSteamId: ticketResult.ownerSteamId,
    familyShared,
    vacBanned: ticketResult.vacBanned,
    publisherBanned: ticketResult.publisherBanned,
    userId,
    entitled,
    deviceCode: null,
    metric,
  };
}
