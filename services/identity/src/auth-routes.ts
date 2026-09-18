import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { findAccount, SIGNED_IN_STATES } from './accounts.ts';
import { ageBand, ageOn, isValidDateOfBirth } from './age.ts';
import { CAPTCHA_ACTIONS, inspectCaptcha, noteCaptchaAttempt, requireCaptcha } from './captcha.ts';
import { loadPermissions, SECOND_FACTOR_METHODS } from './factors.ts';
import { loadUserRoles } from './roles.ts';
import { RETURN_TO } from './settings.ts';
import {
  completeEmailVerification,
  completePasswordReset,
  finishEmailChange,
  finishEmailRevert,
  loginPassword,
  magicLinkEnabled,
  passwordEnabled,
  registerWithPassword,
  requestEmailChange,
  sendEmailVerification,
  sendMagicLink,
  sendPasswordReset,
  signup,
  updatePassword,
  verify,
} from './flows.ts';
import { NO_STORE, sessionHeaders, signedOutHeaders } from './headers.ts';
import { isCanonicalLocale, preferredLocale } from './locale.ts';
import type { PasswordPolicyReason } from './passwords.ts';
import type { Context } from './service.ts';
import { revoke, signedIn } from './session-routes.ts';

export const returnToSchema = z
  .string()
  .max(2048)
  .regex(RETURN_TO, 'Must be a path starting with a single /')
  .describe('Path on the account surface to go to after signing in.');

const signedInSchema = z.object({
  status: z.literal('signed_in'),
  user_id: z.uuid(),
  return_to: z.string().nullable().describe('The return_to given when the link was requested.'),
});

const verifyResponseSchema = z.discriminatedUnion('status', [
  signedInSchema,
  z.object({
    status: z.literal('choose_account'),
    accounts: z
      .array(z.object({ user_id: z.uuid(), created_at: z.iso.datetime() }))
      .describe('Accounts using this email address. Verify again with one of their user_id.'),
  }),
  z.object({
    status: z.literal('signup_required'),
    signup_token: z
      .string()
      .describe('Pass to /api/v1/auth/magic-link/signup with the date of birth.'),
    expires_at: z.iso.datetime(),
  }),
]);

const meSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  email_verified: z.boolean(),
  username: z.string().nullable(),
  username_updated_at: z.iso.datetime().nullable(),
  username_reset_required: z.boolean(),
  account_state: z.string(),
  age_band: z.string(),
  public_profile: z.boolean(),
  leaderboard_visible: z.boolean(),
  locale: z.string().nullable(),
  created_at: z.iso.datetime(),
  roles: z.array(z.object({ id: z.uuid(), slug: z.string(), name: z.string() })),
  permissions: z.array(z.string()),
  session: z.object({ id: z.uuid(), amr: z.array(z.string()), acr: z.string().nullable() }),
});

function requireMagicLink(ctx: Context): void {
  if (!magicLinkEnabled(ctx)) throw new ProblemError('AUTH_METHOD_DISABLED');
}

function requirePassword(ctx: Context): void {
  if (!passwordEnabled(ctx)) throw new ProblemError('AUTH_METHOD_DISABLED');
}

function localeOf(ctx: Context, request: Request, locale: string | undefined): string {
  return (
    locale ??
    preferredLocale(request.headers.get('accept-language')) ??
    ctx.config.email.default_locale
  );
}

function rejectedPassword(reason: PasswordPolicyReason): never {
  throw new ProblemError('PASSWORD_REJECTED', { extensions: { reason } });
}

const passwordSchema = z.string().min(1).max(256).describe('The password.');

const captchaSchema = z
  .string()
  .min(1)
  .max(8192)
  .optional()
  .describe('CAPTCHA solution. Required after captcha.after attempts from this IP.');

export function authRoutes(router: Router<Context>): void {
  router.route({
    method: 'POST',
    path: '/api/v1/auth/magic-link/start',
    operation_id: 'startMagicLink',
    summary: 'Email a magic link for signing in or signing up',
    description:
      'The response is the same whether or not an account uses the address. Opening the link shows a confirmation page, and new users enter their date of birth after confirming.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'magic_link',
    request: {
      body: z.object({
        email: z.email().max(254),
        locale: z
          .string()
          .refine(isCanonicalLocale, 'Must be a canonical locale like en-GB')
          .optional()
          .describe('Language for the email. Defaults to Accept-Language.'),
        return_to: returnToSchema.optional(),
        captcha: captchaSchema,
      }),
    },
    responses: {
      202: {
        description: 'The link is on its way, if the address can use it',
        schema: z.object({ status: z.literal('sent') }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'CAPTCHA_REQUIRED', 'CAPTCHA_INVALID'],
    handler: async ({ ctx, body, request, log, identity }) => {
      requireMagicLink(ctx);
      await requireCaptcha(ctx, request, 'magic_link', body.captcha);
      await sendMagicLink(
        { ctx, request, log, identity },
        {
          email: body.email,
          locale:
            body.locale ??
            preferredLocale(request.headers.get('accept-language')) ??
            ctx.config.email.default_locale,
          returnTo: body.return_to ?? null,
        },
      );
      await noteCaptchaAttempt(ctx, request, 'magic_link');
      return { status: 202, body: { status: 'sent' as const }, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/password/signup',
    operation_id: 'signupWithPassword',
    summary: 'Create an account with an email and password',
    description:
      'The account stays pending_email_verification until the emailed confirmation link is used.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_password',
    request: {
      body: z.object({
        email: z.email().max(254),
        password: passwordSchema,
        date_of_birth: z.iso
          .date()
          .refine((value) => isValidDateOfBirth(value, new Date()), 'Must be a real date of birth')
          .describe('YYYY-MM-DD.'),
        locale: z
          .string()
          .refine(isCanonicalLocale, 'Must be a canonical locale like en-GB')
          .optional()
          .describe('Language for the verification email. Defaults to Accept-Language.'),
        captcha: captchaSchema,
      }),
    },
    responses: {
      201: {
        description: 'Account created. A verification email is on its way.',
        schema: z.object({
          status: z.literal('verification_sent'),
          user_id: z.uuid(),
        }),
      },
    },
    errors: [
      'AUTH_METHOD_DISABLED',
      'PASSWORD_REJECTED',
      'ACCOUNT_LIMIT_REACHED',
      'PARENTAL_CONSENT_UNAVAILABLE',
      'CAPTCHA_REQUIRED',
      'CAPTCHA_INVALID',
    ],
    handler: async ({ ctx, body, request, log, identity }) => {
      requirePassword(ctx);
      await requireCaptcha(ctx, request, 'password_signup', body.captcha);
      const result = await registerWithPassword(
        { ctx, request, log, identity },
        {
          email: body.email,
          password: body.password,
          dateOfBirth: body.date_of_birth,
          locale: localeOf(ctx, request, body.locale),
        },
      );
      await noteCaptchaAttempt(ctx, request, 'password_signup');
      switch (result.status) {
        case 'rejected':
          return rejectedPassword(result.reason);
        case 'account_limit':
          throw new ProblemError('ACCOUNT_LIMIT_REACHED');
        case 'parental_consent_required':
          throw new ProblemError('PARENTAL_CONSENT_UNAVAILABLE');
        case 'created':
          return {
            status: 201,
            headers: NO_STORE,
            body: { status: 'verification_sent' as const, user_id: result.userId },
          };
      }
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/password/login',
    operation_id: 'loginWithPassword',
    summary: 'Sign in with an email and password',
    description: 'The response is the same whether or not an account uses the address.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_password',
    request: {
      body: z.object({
        email: z.email().max(254),
        password: passwordSchema,
        captcha: captchaSchema,
      }),
    },
    responses: {
      200: {
        description: 'Signed in, or a second factor is required.',
        schema: z.discriminatedUnion('status', [
          z.object({ status: z.literal('signed_in'), user_id: z.uuid() }),
          z.object({
            status: z.literal('second_factor_required'),
            challenge: z
              .string()
              .describe('Pass to /api/v1/auth/2fa or a passkey authenticate start.'),
            methods: z
              .array(z.enum(SECOND_FACTOR_METHODS))
              .describe('Which second factors this account can use.'),
            expires_at: z.iso.datetime(),
          }),
        ]),
      },
    },
    errors: [
      'AUTH_METHOD_DISABLED',
      'CREDENTIALS_INCORRECT',
      'CAPTCHA_REQUIRED',
      'CAPTCHA_INVALID',
    ],
    handler: async ({ ctx, body, request, log, identity }) => {
      requirePassword(ctx);
      await requireCaptcha(ctx, request, 'password_login', body.captcha);
      const result = await loginPassword(
        { ctx, request, log, identity },
        { email: body.email, password: body.password },
      );
      if (result.status === 'invalid') throw new ProblemError('CREDENTIALS_INCORRECT');
      if (result.status === 'second_factor_required') {
        return {
          status: 200,
          headers: NO_STORE,
          body: {
            status: 'second_factor_required' as const,
            challenge: result.challenge,
            methods: result.methods,
            expires_at: result.expiresAt.toISOString(),
          },
        };
      }
      return {
        status: 200,
        headers: sessionHeaders(result.session),
        body: { status: 'signed_in' as const, user_id: result.userId },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/captcha',
    operation_id: 'getCaptcha',
    summary: 'Whether a CAPTCHA is required for an auth action from this IP',
    description:
      'Returns the provider and, when a CAPTCHA is required, a challenge or site key to solve before retrying.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'global',
    request: {
      query: z.object({
        action: z.enum(CAPTCHA_ACTIONS).describe('The auth action about to be submitted.'),
      }),
    },
    responses: {
      200: {
        description: 'Whether a CAPTCHA is required, and how to solve it',
        schema: z.object({
          required: z.boolean(),
          provider: z.string(),
          site_key: z.string().nullable(),
          challenge: z
            .object({
              algorithm: z.string(),
              challenge: z.string(),
              salt: z.string(),
              signature: z.string(),
              maxnumber: z.number(),
            })
            .nullable(),
        }),
      },
    },
    handler: async ({ ctx, query, request }) => ({
      status: 200,
      headers: NO_STORE,
      body: await inspectCaptcha(ctx, request, query.action),
    }),
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/password/forgot',
    operation_id: 'forgotPassword',
    summary: 'Email a password reset link',
    description: 'The response is the same whether or not an account uses the address.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'magic_link',
    request: {
      body: z.object({
        email: z.email().max(254),
        locale: z
          .string()
          .refine(isCanonicalLocale, 'Must be a canonical locale like en-GB')
          .optional()
          .describe('Language for the email. Defaults to Accept-Language.'),
      }),
    },
    responses: {
      202: {
        description: 'The link is on its way, if the address can use it',
        schema: z.object({ status: z.literal('sent') }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED'],
    handler: async ({ ctx, body, request, log, identity }) => {
      requirePassword(ctx);
      await sendPasswordReset(
        { ctx, request, log, identity },
        { email: body.email, locale: localeOf(ctx, request, body.locale) },
      );
      return { status: 202, body: { status: 'sent' as const }, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/password/reset',
    operation_id: 'resetPassword',
    summary: 'Choose a new password from a reset link',
    description:
      'Resets the password and signs in. Other sessions end unless keep_other_sessions is true.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: {
      body: z.object({
        token: z.string().min(1).max(256).describe('The token from the reset link.'),
        password: passwordSchema,
        keep_other_sessions: z
          .boolean()
          .default(false)
          .describe(
            'When true, other sessions stay signed in. Unticked by default on the reset form.',
          ),
        user_id: z.uuid().optional().describe('The account to reset, from choose_account.'),
      }),
    },
    responses: {
      200: {
        description: 'Password set and signed in, or the next step.',
        schema: z.discriminatedUnion('status', [
          z.object({ status: z.literal('signed_in'), user_id: z.uuid() }),
          z.object({
            status: z.literal('choose_account'),
            accounts: z
              .array(z.object({ user_id: z.uuid(), created_at: z.iso.datetime() }))
              .describe(
                'Accounts using this email address. Reset again with one of their user_id.',
              ),
          }),
        ]),
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'RESET_TOKEN_INVALID', 'PASSWORD_REJECTED'],
    handler: async ({ ctx, body, request, log, identity }) => {
      requirePassword(ctx);
      const result = await completePasswordReset(
        { ctx, request, log, identity },
        {
          token: body.token,
          password: body.password,
          keepOtherSessions: body.keep_other_sessions,
          userId: body.user_id,
        },
      );
      switch (result.status) {
        case 'invalid':
          throw new ProblemError('RESET_TOKEN_INVALID');
        case 'rejected':
          return rejectedPassword(result.reason);
        case 'choose_account':
          return {
            status: 200,
            headers: NO_STORE,
            body: {
              status: 'choose_account' as const,
              accounts: result.accounts.map((account) => ({
                user_id: account.id,
                created_at: account.created_at.toISOString(),
              })),
            },
          };
        case 'signed_in':
          return {
            status: 200,
            headers: sessionHeaders({
              ...result.session,
              evicted: [...result.session.evicted, ...result.revoked],
            }),
            body: { status: 'signed_in' as const, user_id: result.userId },
          };
      }
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/email/verify/start',
    operation_id: 'startEmailVerification',
    summary: 'Email a confirmation link for an unverified address',
    description: 'The response is the same whether or not a pending account uses the address.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'magic_link',
    request: {
      body: z.object({
        email: z.email().max(254),
        locale: z
          .string()
          .refine(isCanonicalLocale, 'Must be a canonical locale like en-GB')
          .optional(),
      }),
    },
    responses: {
      202: {
        description: 'The link is on its way, if the address can use it',
        schema: z.object({ status: z.literal('sent') }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED'],
    handler: async ({ ctx, body, request, log, identity }) => {
      requirePassword(ctx);
      await sendEmailVerification(
        { ctx, request, log, identity },
        { email: body.email, locale: localeOf(ctx, request, body.locale) },
      );
      return { status: 202, body: { status: 'sent' as const }, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/email/verify',
    operation_id: 'verifyEmail',
    summary: 'Confirm an email address from a verification link',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: {
      body: z.object({ token: z.string().min(1).max(256) }),
    },
    responses: {
      200: {
        description: 'Email confirmed and signed in',
        schema: z.object({ status: z.literal('signed_in'), user_id: z.uuid() }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'EMAIL_VERIFICATION_INVALID'],
    handler: async ({ ctx, body, request, log, identity }) => {
      requirePassword(ctx);
      const result = await completeEmailVerification(
        { ctx, request, log, identity },
        { token: body.token },
      );
      if (result.status === 'invalid') throw new ProblemError('EMAIL_VERIFICATION_INVALID');
      return {
        status: 200,
        headers: sessionHeaders(result.session),
        body: { status: 'signed_in' as const, user_id: result.userId },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/password',
    operation_id: 'setPassword',
    summary: 'Add a password, or change it',
    description:
      'Adding a password needs a recent magic-link sign-in. Changing one needs the current password.',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    rate_limit: 'global',
    request: {
      body: z.object({
        password: passwordSchema,
        current_password: z.string().min(1).max(256).optional(),
      }),
    },
    responses: {
      204: { description: 'The password has been set' },
    },
    errors: [
      'AUTH_METHOD_DISABLED',
      'PASSWORD_REJECTED',
      'CURRENT_PASSWORD_REQUIRED',
      'CURRENT_PASSWORD_INCORRECT',
      'STEP_UP_REQUIRED',
      'ACCOUNT_NOT_FOUND',
    ],
    handler: async ({ ctx, body, identity, request, log }) => {
      requirePassword(ctx);
      const { userId, sessionId } = signedIn(identity);
      const result = await updatePassword(
        { ctx, request, log, identity },
        {
          userId,
          sessionId,
          password: body.password,
          currentPassword: body.current_password,
        },
      );
      switch (result.status) {
        case 'rejected':
          return rejectedPassword(result.reason);
        case 'current_required':
          throw new ProblemError('CURRENT_PASSWORD_REQUIRED');
        case 'current_incorrect':
          throw new ProblemError('CURRENT_PASSWORD_INCORRECT');
        case 'step_up_required':
          throw new ProblemError('STEP_UP_REQUIRED');
        case 'not_found':
          throw new ProblemError('ACCOUNT_NOT_FOUND');
        case 'updated':
          return { status: 204, headers: NO_STORE };
      }
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/magic-link/verify',
    operation_id: 'verifyMagicLink',
    summary: 'Use a magic link',
    description:
      'Signs in to the account using the link’s address. With several accounts, answers choose_account until a user_id is given. With none, answers signup_required and a token for finishing signup.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: {
      body: z.object({
        token: z.string().min(1).max(256).describe('The token from the link.'),
        user_id: z.uuid().optional().describe('The account to sign in to, from choose_account.'),
      }),
    },
    responses: {
      200: {
        description: 'Signed in, or the next step. Signing in sets the session cookie.',
        schema: verifyResponseSchema,
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'MAGIC_LINK_INVALID'],
    handler: async ({ ctx, body, request, log, identity }) => {
      requireMagicLink(ctx);
      const result = await verify(
        { ctx, request, log, identity },
        { token: body.token, userId: body.user_id },
      );
      switch (result.status) {
        case 'invalid':
          throw new ProblemError('MAGIC_LINK_INVALID');
        case 'choose_account':
          return {
            status: 200,
            headers: NO_STORE,
            body: {
              status: 'choose_account' as const,
              accounts: result.accounts.map((account) => ({
                user_id: account.id,
                created_at: account.created_at.toISOString(),
              })),
            },
          };
        case 'signup_required':
          return {
            status: 200,
            headers: NO_STORE,
            body: {
              status: 'signup_required' as const,
              signup_token: result.signupToken,
              expires_at: result.expiresAt.toISOString(),
            },
          };
        case 'signed_in':
          return {
            status: 200,
            headers: sessionHeaders(result.session),
            body: {
              status: 'signed_in' as const,
              user_id: result.userId,
              return_to: result.returnTo,
            },
          };
      }
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/magic-link/signup',
    operation_id: 'completeMagicLinkSignup',
    summary: 'Create an account after opening a magic link',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: {
      body: z.object({
        signup_token: z.string().min(1).max(256),
        date_of_birth: z.iso
          .date()
          .refine((value) => isValidDateOfBirth(value, new Date()), 'Must be a real date of birth')
          .describe('YYYY-MM-DD.'),
      }),
    },
    responses: {
      201: { description: 'Account created and signed in', schema: signedInSchema },
    },
    errors: [
      'AUTH_METHOD_DISABLED',
      'SIGNUP_TOKEN_INVALID',
      'ACCOUNT_LIMIT_REACHED',
      'PARENTAL_CONSENT_UNAVAILABLE',
    ],
    handler: async ({ ctx, body, request, log, identity }) => {
      requireMagicLink(ctx);
      const result = await signup(
        { ctx, request, log, identity },
        { signupToken: body.signup_token, dateOfBirth: body.date_of_birth },
      );
      switch (result.status) {
        case 'invalid':
          throw new ProblemError('SIGNUP_TOKEN_INVALID');
        case 'account_limit':
          throw new ProblemError('ACCOUNT_LIMIT_REACHED');
        case 'parental_consent_required':
          throw new ProblemError('PARENTAL_CONSENT_UNAVAILABLE');
        case 'signed_in':
          return {
            status: 201,
            headers: sessionHeaders(result.session),
            body: {
              status: 'signed_in' as const,
              user_id: result.userId,
              return_to: result.returnTo,
            },
          };
      }
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/logout',
    operation_id: 'logout',
    summary: 'Sign out, ending the session on every surface',
    tags: ['auth'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    allow_aal0: true,
    rate_limit: 'global',
    responses: { 204: { description: 'Signed out. The session cookie is cleared.' } },
    handler: async ({ ctx, identity, log }) => {
      const { sub: userId, sid: sessionId } = identity;
      let revoked: string[] = [];
      if (userId !== null && sessionId !== null) {
        revoked = await revoke(ctx, { userId, reason: 'logout', only: [sessionId] });
        log.info('signed out', { session_id: sessionId });
      }
      return { status: 204, headers: signedOutHeaders(revoked) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/me',
    operation_id: 'getMe',
    summary: 'The signed-in account',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    rate_limit: 'global',
    responses: { 200: { description: 'The account and current session', schema: meSchema } },
    errors: ['ACCOUNT_NOT_FOUND'],
    handler: async ({ ctx, identity }) => {
      const { userId, sessionId } = signedIn(identity);
      const [account, roles, permissions] = await Promise.all([
        findAccount(ctx.db, userId),
        loadUserRoles(ctx.db, userId),
        loadPermissions(ctx.db, userId),
      ]);
      if (!account || account.state === 'deleted') {
        throw new ProblemError('ACCOUNT_NOT_FOUND');
      }
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          id: account.id,
          email: account.email,
          email_verified: account.email_verified_at !== null,
          username: account.username,
          username_updated_at: account.username_updated_at?.toISOString() ?? null,
          username_reset_required: account.username_reset_required,
          account_state: account.state,
          age_band: ageBand(ageOn(account.date_of_birth, new Date()), ctx.config.age.bands),
          public_profile: account.public_profile,
          leaderboard_visible: account.leaderboard_visible,
          locale: account.locale,
          created_at: account.created_at.toISOString(),
          roles: roles.map((role) => ({ id: role.id, slug: role.slug, name: role.name })),
          permissions,
          session: { id: sessionId, amr: identity.amr, acr: identity.acr },
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/email',
    operation_id: 'changeEmail',
    summary: 'Start changing the account email address',
    description:
      'Needs a recent aal2 session. A confirmation link goes to the new address, and a revert link goes to the current one.',
    tags: ['account'],
    auth: 'session',
    step_up: true,
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'magic_link',
    request: { body: z.object({ email: z.email().max(254) }) },
    responses: {
      202: {
        description: 'Confirmation and notice emails are on their way',
        schema: z.object({ status: z.literal('sent') }),
      },
    },
    errors: ['ACCOUNT_NOT_FOUND', 'EMAIL_UNCHANGED', 'ACCOUNT_LIMIT_REACHED', 'STEP_UP_REQUIRED'],
    handler: async ({ ctx, identity, body, request, log }) => {
      const { userId } = signedIn(identity);
      const result = await requestEmailChange({ ctx, request, log }, { userId, email: body.email });
      switch (result.status) {
        case 'not_found':
          throw new ProblemError('ACCOUNT_NOT_FOUND');
        case 'unchanged':
          throw new ProblemError('EMAIL_UNCHANGED');
        case 'account_limit':
          throw new ProblemError('ACCOUNT_LIMIT_REACHED');
        case 'started':
          return { status: 202, headers: NO_STORE, body: { status: 'sent' as const } };
      }
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/email/change',
    operation_id: 'confirmEmailChange',
    summary: 'Confirm a new email address from the emailed link',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: { body: z.object({ token: z.string().min(1).max(256) }) },
    responses: {
      200: {
        description: 'The email address was updated',
        schema: z.object({ status: z.literal('changed'), email: z.string() }),
      },
    },
    errors: ['EMAIL_CHANGE_INVALID', 'ACCOUNT_LIMIT_REACHED'],
    handler: async ({ ctx, body, request, log }) => {
      const result = await finishEmailChange({ ctx, request, log }, { token: body.token });
      switch (result.status) {
        case 'invalid':
          throw new ProblemError('EMAIL_CHANGE_INVALID');
        case 'account_limit':
          throw new ProblemError('ACCOUNT_LIMIT_REACHED');
        case 'confirmed':
          return {
            status: 200,
            headers: NO_STORE,
            body: { status: 'changed' as const, email: result.email },
          };
      }
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/email/revert',
    operation_id: 'revertEmailChange',
    summary: 'Undo an email change from the notice sent to the previous address',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: { body: z.object({ token: z.string().min(1).max(256) }) },
    responses: {
      200: {
        description: 'The previous email address was restored',
        schema: z.object({ status: z.literal('reverted'), email: z.string() }),
      },
    },
    errors: ['EMAIL_REVERT_INVALID', 'ACCOUNT_LIMIT_REACHED'],
    handler: async ({ ctx, body, request, log }) => {
      const result = await finishEmailRevert({ ctx, request, log }, { token: body.token });
      switch (result.status) {
        case 'invalid':
          throw new ProblemError('EMAIL_REVERT_INVALID');
        case 'account_limit':
          throw new ProblemError('ACCOUNT_LIMIT_REACHED');
        case 'reverted':
          return {
            status: 200,
            headers: NO_STORE,
            body: { status: 'reverted' as const, email: result.email },
          };
      }
    },
  });
}
