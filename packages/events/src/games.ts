export const GAMES_EVENTS = {
  entitlementGranted: 'qtiauth.games.entitlement.granted.v1',
  entitlementRevoked: 'qtiauth.games.entitlement.revoked.v1',
  achievementUnlocked: 'qtiauth.games.achievement.unlocked.v1',
  achievementProgressed: 'qtiauth.games.achievement.progressed.v1',
  achievementRevoked: 'qtiauth.games.achievement.revoked.v1',
} as const;

export type GamesEventType = (typeof GAMES_EVENTS)[keyof typeof GAMES_EVENTS];

export const GAME_TRUST_LEVELS = ['player', 'game'] as const;
export type GameTrustLevel = (typeof GAME_TRUST_LEVELS)[number];
