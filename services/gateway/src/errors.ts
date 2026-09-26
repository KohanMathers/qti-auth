import { defineErrors, KIT_ERRORS, mergeErrors } from '@qtiauth/service-kit';

export const GATEWAY_ERRORS = defineErrors({
  AUTHENTICATION_REQUIRED: { status: 401, title: 'Authentication is required' },
  ACCOUNT_BANNED: { status: 403, title: 'The account is banned' },
  ACCOUNT_LOCKED: { status: 403, title: 'The account is locked' },
  LEGAL_ACCEPTANCE_REQUIRED: { status: 403, title: 'Updated legal documents must be accepted' },
  PARENTAL_CONSENT_PENDING: { status: 403, title: 'Parental consent is still pending' },
  STEP_UP_REQUIRED: { status: 403, title: 'Recent two-factor authentication is required' },
  TWO_FACTOR_ENROLMENT_REQUIRED: {
    status: 403,
    title: 'Two-factor authentication must be set up first',
  },
  REAUTHENTICATION_REQUIRED: {
    status: 403,
    title: 'Sign in again to continue',
  },
  GAME_AUTHORITY_MISMATCH: {
    status: 403,
    title: 'The server and player tokens must belong to the same game',
  },
  ORIGIN_NOT_ALLOWED: { status: 403, title: 'The request origin is not allowed' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'The route does not accept this method' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'The request body is too large' },
  RATE_LIMITED: { status: 429, title: 'Too many requests' },
  RATE_LIMIT_UNAVAILABLE: {
    status: 503,
    title: 'Rate limits cannot be checked, so the request was refused',
  },
  UPSTREAM_TIMEOUT: { status: 504, title: 'The service took too long to respond' },
});

export type GatewayErrorCode = keyof typeof GATEWAY_ERRORS;

export const ERRORS = mergeErrors(KIT_ERRORS, GATEWAY_ERRORS);
