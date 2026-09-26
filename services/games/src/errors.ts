import { defineErrors } from '@qtiauth/service-kit';

export const GAMES_ERRORS = defineErrors({
  GAMES_NOT_FOUND: { status: 404, title: 'No such game' },
  GAMES_SLUG_TAKEN: { status: 409, title: 'That slug is already in use' },
  GAMES_INVALID: { status: 400, title: 'This game or product is not valid' },
  GAMES_PRODUCT_NOT_FOUND: { status: 404, title: 'No such product' },
  GAMES_PRODUCT_BASE: { status: 409, title: 'The base product stays with the game' },
  GAMES_PRODUCT_IN_USE: { status: 409, title: 'This product still has entitlements' },
  GAMES_USER_NOT_FOUND: { status: 404, title: 'No such user' },
  GAMES_ENTITLEMENT_NOT_FOUND: { status: 404, title: 'No such entitlement' },
  GAMES_ENTITLEMENT_REVOKED: { status: 409, title: 'This entitlement is already revoked' },
  GAMES_ENTITLEMENT_EXPIRED: { status: 400, title: 'The expiry is already in the past' },
  GAMES_CLIENT_NOT_ALLOWED: { status: 403, title: 'This client cannot act for that game' },
  GAMES_SERVER_UNAVAILABLE: { status: 503, title: 'The game server credential could not be saved' },
  GAMES_IDENTITY_UNAVAILABLE: { status: 503, title: 'The account service could not be reached' },
});
