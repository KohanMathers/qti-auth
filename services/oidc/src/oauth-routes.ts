import type { Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { startDeviceAuthorization } from './device.ts';
import { authorize, introspect, revoke, token, userinfo } from './oauth.ts';
import { pushAuthorization } from './par.ts';
import type { Context } from './service.ts';
import {
  AUTHORIZE_PATH,
  CLIENT_PATH,
  DEVICE_AUTHORIZATION_PATH,
  INTROSPECT_PATH,
  PAR_PATH,
  REVOKE_PATH,
  TOKEN_PATH,
  USERINFO_PATH,
} from './settings.ts';

const authorizeQuery = z.object({
  client_id: z.string().max(64).optional(),
  redirect_uri: z.string().max(2048).optional(),
  response_type: z.string().max(32).optional(),
  scope: z.string().max(1024).optional(),
  state: z.string().max(1024).optional(),
  nonce: z.string().max(1024).optional(),
  code_challenge: z.string().max(128).optional(),
  code_challenge_method: z.string().max(16).optional(),
  request_uri: z.string().max(512).optional(),
});

const oauthClientSchema = z.object({
  client_id: z.string().nullable(),
  scopes: z.array(z.string()),
});

export function oauthRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: AUTHORIZE_PATH,
    operation_id: 'authorize',
    summary: 'Start an OAuth authorization request',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'oauth_authorize',
    request: { query: authorizeQuery },
    responses: {
      302: { description: 'Redirect to the client or the consent screen' },
      200: { description: 'An OAuth error when the redirect cannot be used' },
    },
    handler: ({ ctx, identity, query }) => authorize(ctx, identity, query),
  });

  router.route({
    method: 'POST',
    path: TOKEN_PATH,
    operation_id: 'token',
    summary: 'Exchange an authorization code, refresh token, device code or client credentials',
    tags: ['oidc'],
    auth: 'none',
    rate_limit: 'oauth_token',
    responses: { 200: { description: 'Issued tokens' } },
    handler: ({ ctx, request }) => token(ctx, request),
  });

  router.route({
    method: 'GET',
    path: USERINFO_PATH,
    operation_id: 'userinfo',
    summary: 'Claims for the access token’s subject',
    tags: ['oidc'],
    auth: 'oauth',
    scopes: ['openid'],
    rate_limit: 'global',
    responses: { 200: { description: 'UserInfo claims' } },
    handler: ({ ctx, identity }) => userinfo(ctx, identity),
  });

  router.route({
    method: 'POST',
    path: REVOKE_PATH,
    operation_id: 'revoke',
    summary: 'Revoke an access or refresh token',
    tags: ['oidc'],
    auth: 'none',
    rate_limit: 'oauth_token',
    responses: { 200: { description: 'The token is no longer active' } },
    handler: ({ ctx, request }) => revoke(ctx, request),
  });

  router.route({
    method: 'POST',
    path: INTROSPECT_PATH,
    operation_id: 'introspect',
    summary: 'Inspect an access or refresh token',
    tags: ['oidc'],
    auth: 'none',
    rate_limit: 'oauth_token',
    responses: { 200: { description: 'Token introspection' } },
    handler: ({ ctx, request }) => introspect(ctx, request),
  });

  router.route({
    method: 'POST',
    path: DEVICE_AUTHORIZATION_PATH,
    operation_id: 'deviceAuthorization',
    summary: 'Start a device authorization grant',
    tags: ['oidc'],
    auth: 'none',
    rate_limit: 'oauth_token',
    responses: { 200: { description: 'Device and user codes' } },
    handler: ({ ctx, request }) => startDeviceAuthorization(ctx, request),
  });

  router.route({
    method: 'POST',
    path: PAR_PATH,
    operation_id: 'pushedAuthorization',
    summary: 'Push an authorization request (RFC 9126)',
    tags: ['oidc'],
    auth: 'none',
    rate_limit: 'oauth_authorize',
    responses: { 201: { description: 'A request_uri handle' } },
    handler: ({ ctx, request }) => pushAuthorization(ctx, request),
  });

  router.route({
    method: 'GET',
    path: CLIENT_PATH,
    operation_id: 'oauthClient',
    summary: 'The OAuth client authenticated by a client-credentials access token',
    tags: ['oidc'],
    auth: 'service',
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Client id and scopes',
        schema: oauthClientSchema,
      },
    },
    handler: ({ identity }) =>
      Promise.resolve({
        status: 200 as const,
        headers: { 'cache-control': 'no-store' },
        body: { client_id: identity.client_id, scopes: identity.scopes },
      }),
  });
}
