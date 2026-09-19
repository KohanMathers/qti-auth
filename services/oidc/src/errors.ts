import { defineErrors } from '@qtiauth/service-kit';

export const OIDC_ERRORS = defineErrors({
  CLIENT_NOT_FOUND: { status: 404, title: 'No such OAuth client' },
  AUTHORIZATION_INVALID: {
    status: 400,
    title: 'This authorization request is unknown, has expired or has already been used',
  },
});
