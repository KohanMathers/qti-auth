import { ProblemError } from '@qtiauth/service-kit';

import { type GameRecord, getGameBySlug, isPublicGame } from './catalog.ts';
import type { Context } from './service.ts';

export async function requirePublicGame(ctx: Context, slug: string): Promise<GameRecord> {
  const game = await getGameBySlug(ctx.db, slug);
  if (!game || !isPublicGame(game.status)) throw new ProblemError('GAMES_NOT_FOUND');
  return game;
}

export function requireGameToken(identity: { game_id: string | null }, gameId: string): void {
  if (identity.game_id === null || identity.game_id !== gameId) {
    throw new ProblemError('GAMES_WRONG_GAME_TOKEN');
  }
}
