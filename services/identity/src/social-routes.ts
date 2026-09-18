import { FLOW_BINDING_HEADER, ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { SIGNED_IN_STATES } from './accounts.ts';
import { isValidDateOfBirth } from './age.ts';
import { canRemovePrimaryMethod, lastSignInMethodError } from './factors.ts';
import { completeSocialSignup, finishSocial, socialProviderEnabled, startSocial } from './flows.ts';
import { NO_STORE, sessionHeaders } from './headers.ts';
import { iso } from './iso.ts';
import { isCanonicalLocale, preferredLocale } from './locale.ts';
import { enabledSocialProviders, findSocialProvider } from './providers.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';
import { RETURN_TO } from './settings.ts';
import { deleteSocialIdentity, findSocialIdentity, listSocialIdentities } from './social.ts';

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/;

const providerParam = z.object({
  provider: z
    .string()
    .regex(PROVIDER_ID)
    .describe('google, github, discord, steam, or a generic OIDC id.'),
});

const startBody = z.object({
  locale: z.string().refine(isCanonicalLocale, 'Must be a canonical locale like en-GB').optional(),
  return_to: z
    .string()
    .max(2048)
    .regex(RETURN_TO, 'Must be a path starting with a single /')
    .optional()
    .describe('Path on the account surface to go to after signing in.'),
});

const identitySchema = z.object({
  id: z.uuid(),
  type: z.string(),
  name: z.string(),
  created_at: z.iso.datetime(),
  last_used_at: z.iso.datetime().nullable(),
});

function providerName(ctx: Context, type: string): string {
  const id = type.startsWith('oidc:') ? type.slice(5) : type;
  return findSocialProvider(ctx.config.features.auth.social, id)?.name ?? type;
}

function listedIdentity(
  ctx: Context,
  identity: Awaited<ReturnType<typeof listSocialIdentities>>[number],
) {
  return {
    id: identity.id,
    type: identity.type,
    name: providerName(ctx, identity.type),
    created_at: identity.createdAt.toISOString(),
    last_used_at: iso(identity.lastUsedAt),
  };
}

function localeOf(ctx: Context, request: Request, locale: string | undefined): string {
  return (
    locale ??
    preferredLocale(request.headers.get('accept-language')) ??
    ctx.config.email.default_locale
  );
}

function requireProvider(ctx: Context, providerId: string): void {
  if (!socialProviderEnabled(ctx, providerId)) throw new ProblemError('AUTH_METHOD_DISABLED');
}

async function start(
  flow: Parameters<typeof startSocial>[0],
  input: {
    providerId: string;
    intent: 'signin' | 'link';
    userId: string | null;
    returnTo: string | null;
    locale: string | undefined;
  },
) {
  const { ctx, request } = flow;
  requireProvider(ctx, input.providerId);
  const result = await startSocial(flow, {
    providerId: input.providerId,
    intent: input.intent,
    userId: input.userId,
    returnTo: input.returnTo,
    locale: localeOf(ctx, request, input.locale),
  });
  if (result.status === 'disabled') throw new ProblemError('AUTH_METHOD_DISABLED');
  return result;
}

function completeResponse(
  result: Awaited<ReturnType<typeof finishSocial>>,
):
  | { status: 200; headers: Record<string, string>; body: Record<string, unknown> }
  | { status: 201; headers: Record<string, string>; body: Record<string, unknown> }
  | never {
  switch (result.status) {
    case 'invalid':
    case 'denied':
      throw new ProblemError('OAUTH_FAILED');
    case 'provider_unavailable':
      throw new ProblemError('PROVIDER_UNAVAILABLE');
    case 'identity_in_use':
      throw new ProblemError('IDENTITY_IN_USE');
    case 'account_limit':
      throw new ProblemError('ACCOUNT_LIMIT_REACHED');
    case 'parental_consent_required':
      throw new ProblemError('PARENTAL_CONSENT_UNAVAILABLE');
    case 'linked':
      return {
        status: 200,
        headers: NO_STORE,
        body: { status: 'linked', identity_id: result.identityId, user_id: result.userId },
      };
    case 'signup_required':
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          status: 'signup_required',
          challenge: result.challenge,
          expires_at: result.expiresAt.toISOString(),
          email: result.email,
          email_verified: result.emailVerified,
          needs_email: result.needsEmail,
          needs_date_of_birth: result.needsDateOfBirth,
          return_to: result.returnTo,
        },
      };
    case 'signed_in':
      // 201 when the sign-in created the account, 200 when it signed in to one
      // that already existed.
      return {
        status: result.created ? (201 as const) : (200 as const),
        headers: sessionHeaders(result.session),
        body: {
          status: 'signed_in',
          user_id: result.userId,
          return_to: result.returnTo,
        },
      };
  }
}

export function socialRoutes(router: Router<Context>): void {
  router.route({
    method: 'POST',
    path: '/api/v1/auth/social/:provider/start',
    operation_id: 'startSocialSignIn',
    summary: 'Start sign-in with an upstream provider',
    description:
      'Returns the provider URL to send the browser to. State, PKCE and nonce are stored for 10 minutes.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_password',
    request: { params: providerParam, body: startBody },
    responses: {
      200: {
        description: 'Open this URL to continue at the provider',
        schema: z.object({ url: z.url(), expires_at: z.iso.datetime() }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED'],
    handler: async ({ ctx, params, body, request, log }) => {
      const result = await start(
        { ctx, request, log },
        {
          providerId: params.provider,
          intent: 'signin',
          userId: null,
          returnTo: body.return_to ?? null,
          locale: body.locale,
        },
      );
      return {
        status: 200,
        headers: { ...NO_STORE, [FLOW_BINDING_HEADER]: result.binding },
        body: { url: result.url, expires_at: result.expiresAt.toISOString() },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/identities/:provider/connect',
    operation_id: 'connectSocialIdentity',
    summary: 'Start connecting an upstream provider to this account',
    description:
      'Connecting only happens when the user is signed in and chooses it. Matching emails do not link accounts.',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'auth_password',
    request: { params: providerParam, body: startBody },
    responses: {
      200: {
        description: 'Open this URL to continue at the provider',
        schema: z.object({ url: z.url(), expires_at: z.iso.datetime() }),
      },
    },
    errors: ['AUTH_METHOD_DISABLED'],
    handler: async ({ ctx, params, body, identity, request, log }) => {
      const { userId } = signedIn(identity);
      const result = await start(
        { ctx, request, log, identity },
        {
          providerId: params.provider,
          intent: 'link',
          userId,
          returnTo: body.return_to ?? null,
          locale: body.locale,
        },
      );
      return {
        status: 200,
        headers: { ...NO_STORE, [FLOW_BINDING_HEADER]: result.binding },
        body: { url: result.url, expires_at: result.expiresAt.toISOString() },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/social/complete',
    operation_id: 'completeSocial',
    summary: 'Finish an upstream sign-in or link after the provider redirects back',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: {
      body: z.object({
        provider: z.string().regex(PROVIDER_ID),
        state: z.string().min(1).max(256),
        code: z.string().min(1).max(4096).optional(),
        error: z.string().max(256).optional(),
        params: z.record(z.string(), z.string()).default({}),
      }),
    },
    responses: {
      200: {
        description: 'Signed in, linked, or the next step',
        schema: z.record(z.string(), z.unknown()),
      },
      201: {
        description: 'Account created and signed in',
        schema: z.record(z.string(), z.unknown()),
      },
    },
    errors: [
      'AUTH_METHOD_DISABLED',
      'OAUTH_FAILED',
      'PROVIDER_UNAVAILABLE',
      'IDENTITY_IN_USE',
      'ACCOUNT_LIMIT_REACHED',
      'PARENTAL_CONSENT_UNAVAILABLE',
    ],
    handler: async ({ ctx, body, request, log, identity }) => {
      requireProvider(ctx, body.provider);
      const result = await finishSocial(
        { ctx, request, log, identity },
        {
          providerId: body.provider,
          state: body.state,
          code: body.code,
          params: new URLSearchParams(body.params),
          error: body.error,
        },
      );
      return completeResponse(result);
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/social/signup',
    operation_id: 'completeSocialSignup',
    summary: 'Finish signing up after an upstream provider that needs a date of birth or email',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: {
      body: z.object({
        challenge: z.string().min(1).max(256),
        date_of_birth: z.iso
          .date()
          .refine((value) => isValidDateOfBirth(value, new Date()), 'Must be a real date of birth')
          .optional(),
        email: z.email().max(254).optional(),
      }),
    },
    responses: {
      201: {
        description: 'Account created and signed in',
        schema: z.object({
          status: z.literal('signed_in'),
          user_id: z.uuid(),
          return_to: z.string().nullable(),
        }),
      },
    },
    errors: ['OAUTH_FAILED', 'ACCOUNT_LIMIT_REACHED', 'PARENTAL_CONSENT_UNAVAILABLE'],
    handler: async ({ ctx, body, request, log }) => {
      const result = await completeSocialSignup(
        { ctx, request, log },
        { challenge: body.challenge, dateOfBirth: body.date_of_birth, email: body.email },
      );
      switch (result.status) {
        case 'invalid':
          throw new ProblemError('OAUTH_FAILED');
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
    method: 'GET',
    path: '/api/v1/me/identities',
    operation_id: 'listIdentities',
    summary: 'Connected upstream sign-in methods',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Connected providers',
        schema: z.object({
          identities: z.array(identitySchema),
          available: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
      },
    },
    handler: async ({ ctx, identity }) => {
      const { userId } = signedIn(identity);
      const identities = await listSocialIdentities(ctx.db, userId);
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          identities: identities.map((row) => listedIdentity(ctx, row)),
          available: enabledSocialProviders(ctx.config.features.auth.social).map((provider) => ({
            id: provider.id,
            name: provider.name,
          })),
        },
      };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/me/identities/:identity_id',
    operation_id: 'disconnectSocialIdentity',
    summary: 'Remove a connected upstream sign-in method',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    request: { params: z.object({ identity_id: z.uuid() }) },
    responses: { 204: { description: 'The method was removed' } },
    errors: ['IDENTITY_NOT_FOUND', 'LAST_SIGN_IN_METHOD'],
    handler: async ({ ctx, identity, params }) => {
      const { userId } = signedIn(identity);
      const existing = await findSocialIdentity(ctx.db, { id: params.identity_id, userId });
      if (existing === undefined) throw new ProblemError('IDENTITY_NOT_FOUND');
      if (
        !(await canRemovePrimaryMethod(ctx.db, {
          userId,
          magicLinkEnabled: ctx.config.features.auth.magic_link.enabled,
        }))
      ) {
        throw lastSignInMethodError();
      }
      const deleted = await deleteSocialIdentity(ctx.db, { id: params.identity_id, userId });
      if (!deleted) throw new ProblemError('IDENTITY_NOT_FOUND');
      return { status: 204, headers: NO_STORE };
    },
  });
}
