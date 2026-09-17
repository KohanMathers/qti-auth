import { defineErrors } from '@qtiauth/service-kit';

export const IDENTITY_ERRORS = defineErrors({
  AUTH_METHOD_DISABLED: { status: 403, title: 'This sign-in method is turned off' },
  MAGIC_LINK_INVALID: {
    status: 400,
    title: 'The magic link is unknown, has expired or has already been used',
  },
  SIGNUP_TOKEN_INVALID: {
    status: 400,
    title: 'The signup token is unknown, has expired or has already been used',
  },
  ACCOUNT_LIMIT_REACHED: {
    status: 409,
    title: 'No more accounts can be created with this email address',
  },
  PARENTAL_CONSENT_UNAVAILABLE: {
    status: 403,
    title: 'Accounts that need parental consent cannot be created yet',
  },
  ACCOUNT_NOT_FOUND: { status: 404, title: 'The account does not exist' },
  SESSION_NOT_FOUND: { status: 404, title: 'No such session' },
});

export type IdentityErrorCode = keyof typeof IDENTITY_ERRORS;
