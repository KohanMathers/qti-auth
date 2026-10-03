import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import type { ClientRecord } from './clients.ts';
import {
  decideDeviceAuthorization,
  displayUserCode,
  loadDeviceAuthorization,
  normalizeUserCode,
} from './device.ts';
import { type ConsentOutcome, decideConsent, loadAuthorizationRequest } from './oauth.ts';
import type { Context } from './service.ts';
import { CONSENT_PATH, DEVICE_PATH, DEVICE_VERIFY_PATH } from './settings.ts';

const NO_STORE = { 'cache-control': 'no-store' };

const decision = z.enum(['allow', 'deny']);
const userCode = z.string().min(1).max(32);

const clientSchema = z.object({
  client_id: z.string(),
  name: z.string(),
  verified: z.boolean().describe('False shows an unverified-app notice.'),
});

const scopesSchema = z.array(z.object({ scope: z.string(), description: z.string() }));

function presentClient(client: ClientRecord) {
  return {
    client_id: client.client_id,
    name: client.name,
    verified: client.verified || client.first_party,
  };
}

function presentScopes(ctx: Context, scopes: readonly string[]) {
  return scopes.map((scope) => ({
    scope,
    description: ctx.config.oidc.scopes[scope]?.consent ?? scope,
  }));
}

function redirectBody(outcome: ConsentOutcome) {
  if (outcome.status === 'not_found') throw new ProblemError('AUTHORIZATION_INVALID');
  return { status: 200 as const, headers: NO_STORE, body: { redirect_to: outcome.location } };
}

export function consentRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: CONSENT_PATH,
    operation_id: 'getConsentRequest',
    summary: 'An OAuth authorization request waiting for the signed-in user',
    description:
      'consent asks the user to allow or deny. pending_guardian waits for a parent or guardian; ask again to see their decision. approved and declined are decided: post the matching decision to finish.',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'oauth_authorize',
    request: { query: z.object({ request_id: z.uuid() }) },
    responses: {
      200: {
        description: 'The request',
        schema: z.object({
          state: z.enum(['consent', 'pending_guardian', 'approved', 'declined']),
          client: clientSchema,
          scopes: scopesSchema,
        }),
      },
    },
    errors: ['AUTHORIZATION_INVALID'],
    handler: async ({ ctx, identity, query }) => {
      const now = new Date();
      const loaded = await loadAuthorizationRequest(ctx, identity, query.request_id, now);
      if (!loaded) throw new ProblemError('AUTHORIZATION_INVALID');
      const { row, client } = loaded;
      const state =
        row.guardian_status === 'none'
          ? ('consent' as const)
          : row.guardian_status === 'pending'
            ? row.expires_at <= now
              ? ('declined' as const)
              : ('pending_guardian' as const)
            : row.guardian_status;
      return {
        status: 200,
        headers: NO_STORE,
        body: { state, client: presentClient(client), scopes: presentScopes(ctx, row.scopes) },
      };
    },
  });

  router.route({
    method: 'POST',
    path: CONSENT_PATH,
    operation_id: 'decideConsentRequest',
    summary: 'Allow or deny an OAuth authorization request',
    description:
      'Answers with the client redirect to send the browser to, carrying a code or access_denied. Denying a request that waits for a guardian cancels it.',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'oauth_authorize',
    request: { body: z.object({ request_id: z.uuid(), decision }) },
    responses: {
      200: {
        description: 'Send the browser here',
        schema: z.object({ redirect_to: z.url() }),
      },
    },
    errors: ['AUTHORIZATION_INVALID'],
    handler: async ({ ctx, identity, body }) =>
      redirectBody(await decideConsent(ctx, identity, body)),
  });

  router.route({
    method: 'GET',
    path: DEVICE_PATH,
    operation_id: 'getDeviceRequest',
    summary: 'A device-flow request, looked up by the code shown on the device',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'oauth_authorize',
    request: { query: z.object({ user_code: userCode }) },
    responses: {
      200: {
        description: 'The request',
        schema: z.object({
          state: z.enum(['pending', 'pending_guardian']),
          user_code: z.string(),
          client: clientSchema,
          scopes: scopesSchema,
        }),
      },
    },
    errors: ['DEVICE_CODE_INVALID'],
    handler: async ({ ctx, query }) => {
      const loaded = await loadDeviceAuthorization(ctx, query.user_code);
      const normalized = normalizeUserCode(query.user_code);
      if (!loaded || normalized === undefined) throw new ProblemError('DEVICE_CODE_INVALID');
      const { row, client } = loaded;
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          state:
            row.status === 'pending_guardian'
              ? ('pending_guardian' as const)
              : ('pending' as const),
          user_code: displayUserCode(normalized),
          client: presentClient(client),
          scopes: presentScopes(ctx, row.scopes),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: DEVICE_VERIFY_PATH,
    operation_id: 'decideDeviceRequest',
    summary: 'Allow or deny a device-flow request',
    description:
      'granted lets the device finish signing in. A child allowing a third-party app gets pending_guardian until a parent or guardian decides.',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'oauth_authorize',
    request: { body: z.object({ user_code: userCode, decision }) },
    responses: {
      200: {
        description: 'The outcome',
        schema: z.object({ status: z.enum(['granted', 'denied', 'pending_guardian']) }),
      },
    },
    errors: ['DEVICE_CODE_INVALID'],
    handler: async ({ ctx, identity, body }) => {
      const result = await decideDeviceAuthorization(ctx, identity, body);
      if (result.status === 'not_found') throw new ProblemError('DEVICE_CODE_INVALID');
      return { status: 200, headers: NO_STORE, body: { status: result.status } };
    },
  });
}
