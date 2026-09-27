import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { getGameBySlug } from './catalog.ts';
import { gamesMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { findSteamApp, STEAMID_PATTERN } from './steam.ts';
import { steamAuthOutcomeFor } from './steam-service.ts';

const authenticateBody = z.object({
  app_id: z.int().min(1).max(2_147_483_647),
  ticket: z
    .string()
    .min(2)
    .max(4_096)
    .regex(/^[0-9a-fA-F]+$/, 'Must be a hex-encoded ticket'),
  issue_tokens: z.boolean().default(false),
});

const authenticateResponseSchema = z.object({
  valid: z.boolean(),
  steam_id: z.string().regex(STEAMID_PATTERN).nullable(),
  owner_steam_id: z.string().regex(STEAMID_PATTERN).nullable(),
  family_shared: z.boolean(),
  vac_banned: z.boolean(),
  publisher_banned: z.boolean(),
  entitled: z.boolean(),
  user_id: z.uuid().nullable(),
  device_code: z.string().nullable(),
});

function requireSteamEnabled(ctx: Context): void {
  if (!ctx.config.features.games.steam.enabled) {
    throw new ProblemError('GAMES_STEAM_DISABLED');
  }
  if (!ctx.config.games.steam.publisher_key) {
    throw new ProblemError('GAMES_STEAM_UNAVAILABLE');
  }
}

export function steamRoutes(router: Router<Context>): void {
  router.route({
    method: 'POST',
    path: '/api/v1/games/steam/authenticate',
    operation_id: 'authenticateSteamTicket',
    summary: 'Validate a Steam auth ticket',
    description:
      'Verifies a Steamworks GetAuthTicketForWebApi ticket, applies the app family-sharing policy, records ban flags, and returns whether the SteamID64 is linked to a QTIAuth user and owns the game.',
    tags: ['games', 'steam'],
    auth: 'service',
    rate_limit: 'global',
    request: { body: authenticateBody },
    responses: {
      200: { description: 'The ticket outcome', schema: authenticateResponseSchema },
    },
    errors: [
      'GAMES_STEAM_DISABLED',
      'GAMES_STEAM_UNAVAILABLE',
      'GAMES_STEAM_APP_UNKNOWN',
      'GAMES_STEAM_TICKET_REJECTED',
      'GAMES_STEAM_FAMILY_DENIED',
      'GAMES_NOT_FOUND',
    ],
    handler: async ({ ctx, body }) => {
      requireSteamEnabled(ctx);
      const app = findSteamApp(ctx.config.games.steam.apps, body.app_id);
      if (!app) throw new ProblemError('GAMES_STEAM_APP_UNKNOWN');
      const game = await getGameBySlug(ctx.db, app.game_slug);
      if (!game) throw new ProblemError('GAMES_NOT_FOUND');
      const outcome = await steamAuthOutcomeFor(ctx, {
        app,
        game,
        ticket: body.ticket,
        issueTokens: body.issue_tokens,
        now: new Date(),
      });
      gamesMetrics(ctx.metrics).steamAuthenticate(outcome.metric);
      if (outcome.status === 'ticket_rejected') {
        throw new ProblemError('GAMES_STEAM_TICKET_REJECTED');
      }
      if (outcome.status === 'family_denied') {
        throw new ProblemError('GAMES_STEAM_FAMILY_DENIED');
      }
      if (outcome.status === 'steam_unavailable') {
        throw new ProblemError('GAMES_STEAM_UNAVAILABLE');
      }
      return {
        status: 200 as const,
        body: {
          valid: true,
          steam_id: outcome.steamId,
          owner_steam_id: outcome.ownerSteamId,
          family_shared: outcome.familyShared,
          vac_banned: outcome.vacBanned,
          publisher_banned: outcome.publisherBanned,
          entitled: outcome.entitled,
          user_id: outcome.userId,
          device_code: outcome.deviceCode,
        },
      };
    },
  });
}
