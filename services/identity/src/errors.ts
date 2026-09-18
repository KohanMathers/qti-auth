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
  CREDENTIALS_INCORRECT: { status: 401, title: 'Email or password incorrect' },
  PASSWORD_REJECTED: { status: 400, title: 'This password does not meet the requirements' },
  RESET_TOKEN_INVALID: {
    status: 400,
    title: 'The reset link is unknown, has expired or has already been used',
  },
  EMAIL_VERIFICATION_INVALID: {
    status: 400,
    title: 'The verification link is unknown, has expired or has already been used',
  },
  CURRENT_PASSWORD_REQUIRED: { status: 400, title: 'The current password is required' },
  CURRENT_PASSWORD_INCORRECT: { status: 400, title: 'The current password is incorrect' },
  STEP_UP_REQUIRED: {
    status: 403,
    title: 'Recent two-factor authentication is required',
  },
  CHALLENGE_INVALID: {
    status: 400,
    title: 'The challenge is unknown, has expired or has already been used',
  },
  PASSKEY_INVALID: { status: 400, title: 'The passkey could not be verified' },
  PASSKEY_NOT_FOUND: { status: 404, title: 'No such passkey' },
  TOTP_INVALID: { status: 400, title: 'The authenticator code is incorrect' },
  TOTP_ALREADY_ENABLED: { status: 409, title: 'Authenticator app sign-in is already set up' },
  TOTP_NOT_ENABLED: { status: 400, title: 'Authenticator app sign-in is not set up' },
  RECOVERY_CODE_INVALID: { status: 400, title: 'The recovery code is incorrect or has been used' },
  LAST_SIGN_IN_METHOD: {
    status: 409,
    title: 'This is your last available sign-in method',
  },
  DATE_OF_BIRTH_INVALID: { status: 400, title: 'This date of birth is not valid' },
  DATE_OF_BIRTH_UNCHANGED: {
    status: 400,
    title: 'That is already this account’s date of birth',
  },
  OAUTH_FAILED: { status: 400, title: 'Sign-in with this provider could not be completed' },
  IDENTITY_IN_USE: {
    status: 409,
    title: 'This sign-in method is already connected to another account',
  },
  IDENTITY_NOT_FOUND: { status: 404, title: 'No such connected sign-in method' },
  EMAIL_UNCHANGED: { status: 400, title: 'That is already this account’s email address' },
  EMAIL_CHANGE_INVALID: {
    status: 400,
    title: 'The email change link is unknown, has expired or has already been used',
  },
  EMAIL_REVERT_INVALID: {
    status: 400,
    title: 'The email revert link is unknown, has expired or has already been used',
  },
  PROVIDER_UNAVAILABLE: {
    status: 502,
    title: 'This sign-in provider is temporarily unavailable',
  },
  FILTER_ENTRY_NOT_FOUND: { status: 404, title: 'No such list entry' },
  USERNAME_INVALID: { status: 400, title: 'This username does not meet the requirements' },
  USERNAME_UNAVAILABLE: { status: 409, title: 'Username not available' },
  USERNAME_UNCHANGED: { status: 400, title: 'That is already this account’s username' },
  USERNAME_COOLDOWN: { status: 409, title: 'This username cannot be changed yet' },
  USERNAME_CHANGE_LIMIT: {
    status: 409,
    title: 'The username change limit has been reached',
  },
  CAPTCHA_REQUIRED: { status: 403, title: 'Complete the CAPTCHA to continue' },
  CAPTCHA_INVALID: { status: 400, title: 'The CAPTCHA was not completed correctly' },
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
  ROLE_NOT_FOUND: { status: 404, title: 'No such role' },
  ROLE_SLUG_TAKEN: { status: 409, title: 'A role with this slug already exists' },
  ROLE_BUILTIN: { status: 409, title: 'Built-in roles cannot be deleted' },
});

export type IdentityErrorCode = keyof typeof IDENTITY_ERRORS;
