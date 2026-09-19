import type { Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { authorize, introspect, revoke, token, userinfo } from './oauth.ts';
import type { Context } from './service.ts';
import {
  AUTHORIZE_PATH,
  INTROSPECT_PATH,
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
    summary: 'Exchange an authorization code or refresh token',
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
}
