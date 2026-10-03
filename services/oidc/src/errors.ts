import { defineErrors } from '@qtiauth/service-kit';

export const OIDC_ERRORS = defineErrors({
  CLIENT_NOT_FOUND: { status: 404, title: 'No such OAuth client' },
  AUTHORIZATION_INVALID: {
    status: 400,
    title: 'This authorization request is unknown, has expired or has already been used',
  },
  DEVICE_CODE_INVALID: {
    status: 400,
    title: 'This device code is unknown, has expired or has already been used',
  },
  DEVELOPER_PORTAL_DISABLED: { status: 403, title: 'The developer portal is turned off' },
  CLIENT_CHILD_ACCOUNT: {
    status: 403,
    title: 'Child accounts cannot register OAuth clients',
  },
  CLIENT_LIMIT_REACHED: {
    status: 409,
    title: 'No more OAuth clients can be created on this account',
  },
  CLIENT_NAME_REJECTED: { status: 400, title: 'This client name is not allowed' },
  CLIENT_DESCRIPTION_REJECTED: { status: 400, title: 'This client description is not allowed' },
  CLIENT_SECRET_NOT_APPLICABLE: {
    status: 400,
    title: 'Public clients do not have a secret',
  },
});
