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
});

export type IdentityErrorCode = keyof typeof IDENTITY_ERRORS;
