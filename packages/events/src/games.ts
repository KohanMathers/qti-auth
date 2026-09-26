export const GAMES_EVENTS = {
  entitlementGranted: 'qtiauth.games.entitlement.granted.v1',
  entitlementRevoked: 'qtiauth.games.entitlement.revoked.v1',
} as const;

export type GamesEventType = (typeof GAMES_EVENTS)[keyof typeof GAMES_EVENTS];
