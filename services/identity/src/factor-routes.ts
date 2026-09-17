import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { findAccount, SIGNED_IN_STATES } from './accounts.ts';
import { canRemovePasskey, lastSignInMethodError, totpEnrolled } from './factors.ts';
import { finishTwoFactor, notifyNewDevice, passkeysEnabled, totpEnabled } from './flows.ts';
import { NO_STORE, revokedHeaders, sessionHeaders } from './headers.ts';
import { identityMetrics } from './metrics.ts';
import { deletePasskey, listPasskeys, PASSKEY_NAME_MAX, renamePasskey } from './passkeys.ts';
import { replaceRecoveryCodes, unusedRecoveryCount } from './recovery.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';
import {
  clientFor,
  encryptionKey,
  relyingParty,
  sessionClient,
  sessionSettings,
} from './settings.ts';
import {
  beginPasskeyAuthenticate,
  beginPasskeyRegister,
  beginTotpEnrol,
  completePasskeyAuthenticate,
  completePasskeyRegister,
  confirmTotpEnrol,
  disableTotp,
  stepUpSession,
} from './two-factor.ts';

const challengeSchema = z
  .string()
  .min(1)
  .max(256)
  .describe('The challenge from the previous step.');
const totpSchema = z.string().min(1).max(16).describe('The 6-digit authenticator code.');
const recoverySchema = z
  .string()
  .min(1)
  .max(32)
  .describe('A single-use recovery code, such as ABCDE-FGHIJ.');
const passkeyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(PASSKEY_NAME_MAX)
  .describe('A name for this passkey.');

const webauthnRegistrationSchema = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z.object({
      clientDataJSON: z.string().min(1),
      attestationObject: z.string().min(1),
      transports: z.array(z.string()).optional(),
    }),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.string().optional(),
  })
  .describe('The authenticator attestation returned by the browser.');

const webauthnAuthenticationSchema = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z.object({
      clientDataJSON: z.string().min(1),
      authenticatorData: z.string().min(1),
      signature: z.string().min(1),
      userHandle: z.string().max(1024).nullable().optional(),
    }),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.string().optional(),
  })
  .describe('The authenticator assertion returned by the browser.');

const passkeySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  created_at: z.iso.datetime(),
  last_used_at: z.iso.datetime().nullable(),
});

function listedPasskey(passkey: Awaited<ReturnType<typeof listPasskeys>>[number]) {
  return {
    id: passkey.id,
    name: passkey.name,
    created_at: passkey.createdAt.toISOString(),
    last_used_at: passkey.lastUsedAt?.toISOString() ?? null,
  };
}

function requirePasskeys(ctx: Context): void {
  if (!passkeysEnabled(ctx)) throw new ProblemError('AUTH_METHOD_DISABLED');
}

function requireTotp(ctx: Context): void {
  if (!totpEnabled(ctx)) throw new ProblemError('AUTH_METHOD_DISABLED');
}

export function factorRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/me/factors',
    operation_id: 'listFactors',
    summary: 'Whether two-factor methods are set up on this account',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Enrolled factors',
        schema: z.object({
          totp: z.boolean(),
          recovery_codes: z.number().int(),
          passkeys: z.array(passkeySchema),
        }),
      },
    },
    handler: async ({ ctx, identity }) => {
      const { userId } = signedIn(identity);
      const passkeys = await listPasskeys(ctx.db, userId);
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          totp: await totpEnrolled(ctx.db, userId),
          recovery_codes: await unusedRecoveryCount(ctx.db, userId),
          passkeys: passkeys.map(listedPasskey),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/totp/start',
    operation_id: 'startTotp',
    summary: 'Begin authenticator-app enrolment',
    description: 'Returns an otpauth URI and secret to add to an authenticator app, then confirm.',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Scan the otpauth URI or enter the secret, then confirm with a code',
        schema: z.object({
          challenge: z.string(),
          otpauth: z.string(),
          secret: z.string(),
          expires_at: z.iso.datetime(),
        }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'TOTP_ALREADY_ENABLED', 'ACCOUNT_NOT_FOUND'],
    handler: async ({ ctx, identity }) => {
      requireTotp(ctx);
      const { userId } = signedIn(identity);
      const account = await findAccount(ctx.db, userId);
      if (!account || account.state === 'deleted') throw new ProblemError('ACCOUNT_NOT_FOUND');
      const result = await beginTotpEnrol(ctx.db, {
        userId,
        email: account.email,
        issuer: ctx.config.branding.product_name,
        now: new Date(),
      });
      if (result.status === 'already_enabled') throw new ProblemError('TOTP_ALREADY_ENABLED');
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          challenge: result.challenge,
          otpauth: result.otpauth,
          secret: result.secret,
          expires_at: result.expiresAt.toISOString(),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/totp',
    operation_id: 'confirmTotp',
    summary: 'Finish authenticator-app enrolment',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    rate_limit: 'global',
    request: {
      body: z.object({ challenge: challengeSchema, code: totpSchema }),
    },
    responses: {
      200: {
        description: 'Authenticator app sign-in is on. Store the recovery codes.',
        schema: z.object({
          status: z.literal('enabled'),
          recovery_codes: z.array(z.string()),
        }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'CHALLENGE_INVALID', 'TOTP_INVALID', 'TOTP_ALREADY_ENABLED'],
    handler: async ({ ctx, identity, body }) => {
      requireTotp(ctx);
      const { userId, sessionId } = signedIn(identity);
      const result = await confirmTotpEnrol(ctx.db, {
        userId,
        challenge: body.challenge,
        code: body.code,
        key: encryptionKey(ctx.config),
        now: new Date(),
      });
      switch (result.status) {
        case 'invalid':
          throw new ProblemError('CHALLENGE_INVALID');
        case 'wrong_code':
          throw new ProblemError('TOTP_INVALID');
        case 'already_enabled':
          throw new ProblemError('TOTP_ALREADY_ENABLED');
        case 'enabled':
          return {
            status: 200,
            headers: revokedHeaders([sessionId]),
            body: { status: 'enabled' as const, recovery_codes: result.recoveryCodes },
          };
      }
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/totp/disable',
    operation_id: 'disableTotp',
    summary: 'Turn off authenticator-app sign-in',
    description: 'Needs a current authenticator code. Recovery codes for this account are deleted.',
    tags: ['account'],
    auth: 'session',
    rate_limit: 'global',
    request: { body: z.object({ code: totpSchema }) },
    responses: { 204: { description: 'Authenticator-app sign-in is off' } },
    errors: ['AUTH_METHOD_DISABLED', 'TOTP_NOT_ENABLED', 'TOTP_INVALID'],
    handler: async ({ ctx, identity, body }) => {
      requireTotp(ctx);
      const { userId, sessionId } = signedIn(identity);
      const result = await disableTotp(ctx.db, {
        userId,
        code: body.code,
        key: encryptionKey(ctx.config),
        now: new Date(),
      });
      if (result === 'not_enabled') throw new ProblemError('TOTP_NOT_ENABLED');
      if (result === 'wrong_code') throw new ProblemError('TOTP_INVALID');
      return { status: 204, headers: revokedHeaders([sessionId]) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/recovery-codes',
    operation_id: 'regenerateRecoveryCodes',
    summary: 'Replace recovery codes with a new set of ten',
    description: 'Needs a recent step-up. Previous unused codes stop working.',
    tags: ['account'],
    auth: 'session',
    step_up: true,
    rate_limit: 'global',
    responses: {
      200: {
        description: 'The new recovery codes. Store them; they are not shown again.',
        schema: z.object({ recovery_codes: z.array(z.string()) }),
      },
    },
    handler: async ({ ctx, identity }) => {
      const { userId } = signedIn(identity);
      const recoveryCodes = await replaceRecoveryCodes(ctx.db, userId, new Date());
      return { status: 200, headers: NO_STORE, body: { recovery_codes: recoveryCodes } };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/me/passkeys',
    operation_id: 'listPasskeys',
    summary: 'Passkeys on this account',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Named passkeys, oldest first',
        schema: z.object({ passkeys: z.array(passkeySchema) }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED'],
    handler: async ({ ctx, identity }) => {
      requirePasskeys(ctx);
      const { userId } = signedIn(identity);
      return {
        status: 200,
        headers: NO_STORE,
        body: { passkeys: (await listPasskeys(ctx.db, userId)).map(listedPasskey) },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/passkeys/register/start',
    operation_id: 'startPasskeyRegister',
    summary: 'Begin passkey registration',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    rate_limit: 'global',
    responses: {
      200: {
        description: 'WebAuthn creation options for the browser',
        schema: z.object({
          challenge: z.string(),
          options: z.record(z.string(), z.unknown()),
          expires_at: z.iso.datetime(),
        }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'ACCOUNT_NOT_FOUND'],
    handler: async ({ ctx, identity }) => {
      requirePasskeys(ctx);
      const { userId } = signedIn(identity);
      const account = await findAccount(ctx.db, userId);
      if (!account || account.state === 'deleted') throw new ProblemError('ACCOUNT_NOT_FOUND');
      const result = await beginPasskeyRegister(ctx.db, {
        userId,
        userName: account.email,
        rp: relyingParty(ctx.config),
        now: new Date(),
      });
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          challenge: result.challenge,
          options: result.options as unknown as Record<string, unknown>,
          expires_at: result.expiresAt.toISOString(),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/passkeys/register',
    operation_id: 'registerPasskey',
    summary: 'Finish passkey registration',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    allow_pending_2fa_enrolment: true,
    rate_limit: 'global',
    request: {
      body: z.object({
        challenge: challengeSchema,
        name: passkeyNameSchema,
        response: webauthnRegistrationSchema,
      }),
    },
    responses: {
      201: {
        description: 'The passkey is registered',
        schema: z.object({ status: z.literal('registered'), id: z.uuid() }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'CHALLENGE_INVALID', 'PASSKEY_INVALID'],
    handler: async ({ ctx, identity, body }) => {
      requirePasskeys(ctx);
      const { userId, sessionId } = signedIn(identity);
      const result = await completePasskeyRegister(ctx.db, {
        userId,
        challenge: body.challenge,
        name: body.name,
        response: body.response as unknown as RegistrationResponseJSON,
        rp: relyingParty(ctx.config),
        now: new Date(),
      });
      if (result.status === 'invalid') throw new ProblemError('PASSKEY_INVALID');
      identityMetrics(ctx.metrics).passkeyRegistration();
      return {
        status: 201,
        headers: revokedHeaders([sessionId]),
        body: { status: 'registered' as const, id: result.id },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/passkeys/:passkey_id',
    operation_id: 'renamePasskey',
    summary: 'Rename a passkey',
    tags: ['account'],
    auth: 'session',
    rate_limit: 'global',
    request: {
      params: z.object({ passkey_id: z.uuid() }),
      body: z.object({ name: passkeyNameSchema }),
    },
    responses: { 204: { description: 'The name was saved' } },
    errors: ['AUTH_METHOD_DISABLED', 'PASSKEY_NOT_FOUND'],
    handler: async ({ ctx, identity, params, body }) => {
      requirePasskeys(ctx);
      const { userId } = signedIn(identity);
      const renamed = await renamePasskey(ctx.db, {
        id: params.passkey_id,
        userId,
        name: body.name,
      });
      if (!renamed) throw new ProblemError('PASSKEY_NOT_FOUND');
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/me/passkeys/:passkey_id',
    operation_id: 'deletePasskey',
    summary: 'Remove a passkey',
    tags: ['account'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ passkey_id: z.uuid() }) },
    responses: { 204: { description: 'The passkey was removed' } },
    errors: ['AUTH_METHOD_DISABLED', 'PASSKEY_NOT_FOUND', 'LAST_SIGN_IN_METHOD'],
    handler: async ({ ctx, identity, params }) => {
      requirePasskeys(ctx);
      const { userId } = signedIn(identity);
      const existing = (await listPasskeys(ctx.db, userId)).some(
        (passkey) => passkey.id === params.passkey_id,
      );
      if (!existing) throw new ProblemError('PASSKEY_NOT_FOUND');
      if (
        !(await canRemovePasskey(ctx.db, {
          userId,
          magicLinkEnabled: ctx.config.features.auth.magic_link.enabled,
        }))
      ) {
        throw lastSignInMethodError();
      }
      const deleted = await deletePasskey(ctx.db, { id: params.passkey_id, userId });
      if (!deleted) throw new ProblemError('PASSKEY_NOT_FOUND');
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/2fa',
    operation_id: 'completeTwoFactor',
    summary: 'Finish sign-in with an authenticator or recovery code',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_password',
    request: {
      body: z.object({
        challenge: challengeSchema,
        totp: totpSchema.optional(),
        recovery_code: recoverySchema.optional(),
      }),
    },
    responses: {
      200: {
        description: 'Signed in. Sets the session cookie.',
        schema: z.object({ status: z.literal('signed_in'), user_id: z.uuid() }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'CHALLENGE_INVALID', 'TOTP_INVALID', 'RECOVERY_CODE_INVALID'],
    handler: async ({ ctx, body, request, log, identity }) => {
      if (body.totp !== undefined) requireTotp(ctx);
      const factor = body.totp !== undefined ? 'totp' : 'recovery';
      const result = await finishTwoFactor(
        { ctx, request, log, identity },
        { challenge: body.challenge, totp: body.totp, recoveryCode: body.recovery_code },
      );
      if (result.status === 'invalid') throw new ProblemError('CHALLENGE_INVALID');
      if (result.status === 'wrong_code') {
        throw new ProblemError(factor === 'totp' ? 'TOTP_INVALID' : 'RECOVERY_CODE_INVALID');
      }
      return {
        status: 200,
        headers: sessionHeaders(result.session),
        body: { status: 'signed_in' as const, user_id: result.userId },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/passkey/authenticate/start',
    operation_id: 'startPasskeyAuthenticate',
    summary: 'Begin passkey sign-in',
    description:
      'With second_factor, the options are limited to passkeys on the account that just used a password.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_password',
    request: {
      body: z.object({
        second_factor: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe('The challenge from a second_factor_required password sign-in.'),
      }),
    },
    responses: {
      200: {
        description: 'WebAuthn request options for the browser',
        schema: z.object({
          challenge: z.string(),
          options: z.record(z.string(), z.unknown()),
          expires_at: z.iso.datetime(),
        }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'CHALLENGE_INVALID'],
    handler: async ({ ctx, body }) => {
      requirePasskeys(ctx);
      const result = await beginPasskeyAuthenticate(ctx.db, {
        rp: relyingParty(ctx.config),
        secondFactorChallenge: body.second_factor,
        now: new Date(),
      });
      if (result.status === 'invalid') throw new ProblemError('CHALLENGE_INVALID');
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          challenge: result.challenge,
          options: result.options as unknown as Record<string, unknown>,
          expires_at: result.expiresAt.toISOString(),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/passkey/authenticate',
    operation_id: 'authenticatePasskey',
    summary: 'Finish passkey sign-in',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_password',
    request: {
      body: z.object({
        challenge: challengeSchema,
        response: webauthnAuthenticationSchema,
      }),
    },
    responses: {
      200: {
        description: 'Signed in. Sets the session cookie.',
        schema: z.object({ status: z.literal('signed_in'), user_id: z.uuid() }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'PASSKEY_INVALID', 'CHALLENGE_INVALID'],
    handler: async ({ ctx, body, request, log, identity }) => {
      requirePasskeys(ctx);
      const metrics = identityMetrics(ctx.metrics);
      const result = await completePasskeyAuthenticate(ctx.db, {
        challenge: body.challenge,
        response: body.response as unknown as AuthenticationResponseJSON,
        rp: relyingParty(ctx.config),
        client: clientFor(ctx, request, identity),
        sessions: sessionSettings(ctx.config),
        now: new Date(),
      });
      if (result.status !== 'signed_in') {
        metrics.signIn('passkey', 'failure');
        throw new ProblemError('PASSKEY_INVALID');
      }
      ctx.outbox.wake();
      if (result.secondFactor) metrics.twoFactor('passkey', 'success');
      metrics.signIn(result.authMethod, 'success');
      if (!result.session.restored) {
        metrics.sessionCreated(result.authMethod, result.session.evicted.length);
      }
      await notifyNewDevice(ctx, result.session);
      log.info('signed in', {
        method: result.authMethod,
        user_id: result.userId,
        session_id: result.session.id,
        evicted_sessions: result.session.evicted.length,
      });
      return {
        status: 200,
        headers: sessionHeaders(result.session),
        body: { status: 'signed_in' as const, user_id: result.userId },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/step-up',
    operation_id: 'stepUp',
    summary: 'Raise this session to aal2 with an authenticator or recovery code',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    rate_limit: 'global',
    request: {
      body: z.object({
        totp: totpSchema.optional(),
        recovery_code: recoverySchema.optional(),
      }),
    },
    responses: { 204: { description: 'This session is now aal2' } },
    errors: ['AUTH_METHOD_DISABLED', 'TOTP_INVALID', 'RECOVERY_CODE_INVALID', 'SESSION_NOT_FOUND'],
    handler: async ({ ctx, identity, body }) => {
      if (body.totp !== undefined) requireTotp(ctx);
      const { userId, sessionId } = signedIn(identity);
      const metrics = identityMetrics(ctx.metrics);
      const factor = body.totp !== undefined ? 'totp' : 'recovery';
      metrics.stepUp('prompt');
      const result = await stepUpSession(ctx.db, {
        userId,
        sessionId,
        totp: body.totp,
        recoveryCode: body.recovery_code,
        key: encryptionKey(ctx.config),
        now: new Date(),
      });
      if (result === 'not_found') {
        metrics.stepUp('failure');
        throw new ProblemError('SESSION_NOT_FOUND');
      }
      if (result === 'wrong_code') {
        metrics.stepUp('failure');
        metrics.twoFactor(factor, 'failure');
        throw new ProblemError(factor === 'totp' ? 'TOTP_INVALID' : 'RECOVERY_CODE_INVALID');
      }
      metrics.stepUp('success');
      metrics.twoFactor(factor, 'success');
      return { status: 204, headers: revokedHeaders([sessionId]) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/step-up/passkey/start',
    operation_id: 'startPasskeyStepUp',
    summary: 'Begin passkey step-up for this session',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    rate_limit: 'global',
    responses: {
      200: {
        description: 'WebAuthn request options for the browser',
        schema: z.object({
          challenge: z.string(),
          options: z.record(z.string(), z.unknown()),
          expires_at: z.iso.datetime(),
        }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED', 'PASSKEY_NOT_FOUND'],
    handler: async ({ ctx, identity }) => {
      requirePasskeys(ctx);
      const { userId } = signedIn(identity);
      identityMetrics(ctx.metrics).stepUp('prompt');
      const result = await beginPasskeyAuthenticate(ctx.db, {
        rp: relyingParty(ctx.config),
        userId,
        now: new Date(),
      });
      if (result.status === 'invalid') throw new ProblemError('PASSKEY_NOT_FOUND');
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          challenge: result.challenge,
          options: result.options as unknown as Record<string, unknown>,
          expires_at: result.expiresAt.toISOString(),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/step-up/passkey',
    operation_id: 'completePasskeyStepUp',
    summary: 'Finish passkey step-up for this session',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    rate_limit: 'global',
    request: {
      body: z.object({
        challenge: challengeSchema,
        response: webauthnAuthenticationSchema,
      }),
    },
    responses: { 204: { description: 'This session is now aal2' } },
    errors: ['AUTH_METHOD_DISABLED', 'PASSKEY_INVALID', 'CHALLENGE_INVALID'],
    handler: async ({ ctx, identity, body, request }) => {
      requirePasskeys(ctx);
      const { sessionId } = signedIn(identity);
      const metrics = identityMetrics(ctx.metrics);
      const result = await completePasskeyAuthenticate(ctx.db, {
        challenge: body.challenge,
        response: body.response as unknown as AuthenticationResponseJSON,
        rp: relyingParty(ctx.config),
        client: sessionClient(ctx.config, request),
        sessions: sessionSettings(ctx.config),
        now: new Date(),
        sessionId,
      });
      if (result.status !== 'stepped_up') {
        metrics.stepUp('failure');
        metrics.twoFactor('passkey', 'failure');
        throw new ProblemError('PASSKEY_INVALID');
      }
      metrics.stepUp('success');
      metrics.twoFactor('passkey', 'success');
      return { status: 204, headers: revokedHeaders([sessionId]) };
    },
  });
}
