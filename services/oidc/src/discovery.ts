import type { Router } from '@qtiauth/service-kit';

import { keyringOf } from './keys.ts';
import { claimsFor } from './scopes.ts';
import type { Context } from './service.ts';
import {
  AUTHORIZE_PATH,
  DISCOVERY_PATH,
  INTROSPECT_PATH,
  issuerUrl,
  JWKS_PATH,
  REVOKE_PATH,
  TOKEN_PATH,
  USERINFO_PATH,
} from './settings.ts';

function endpoint(issuer: string, path: string): string {
  return `${issuer}${path}`;
}

export function discoveryDocument(ctx: Context, issuer: string): Record<string, unknown> {
  const algorithm = ctx.config.oidc.signing.algorithm;
  const scopes = Object.keys(ctx.config.oidc.scopes);
  const claims = [...new Set(['sub', ...claimsFor(scopes, ctx.config.oidc.scopes)])];
  return {
    issuer,
    authorization_endpoint: endpoint(issuer, AUTHORIZE_PATH),
    token_endpoint: endpoint(issuer, TOKEN_PATH),
    userinfo_endpoint: endpoint(issuer, USERINFO_PATH),
    revocation_endpoint: endpoint(issuer, REVOKE_PATH),
    introspection_endpoint: endpoint(issuer, INTROSPECT_PATH),
    jwks_uri: endpoint(issuer, JWKS_PATH),
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [algorithm],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: scopes,
    claims_supported: claims,
  };
}

export function discoveryRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: DISCOVERY_PATH,
    operation_id: 'openidConfiguration',
    summary: 'OpenID Connect discovery document',
    tags: ['oidc'],
    auth: 'none',
    rate_limit: 'global',
    responses: { 200: { description: 'Provider metadata' } },
    handler: ({ ctx }) =>
      Promise.resolve(
        Response.json(discoveryDocument(ctx, issuerUrl(ctx.config)), {
          headers: { 'cache-control': 'no-store' },
        }),
      ),
  });

  router.route({
    method: 'GET',
    path: JWKS_PATH,
    operation_id: 'jwks',
    summary: 'JSON Web Key Set for ID and access tokens',
    tags: ['oidc'],
    auth: 'none',
    rate_limit: 'global',
    responses: { 200: { description: 'Public signing keys' } },
    handler: async ({ ctx }) => {
      const keyring = keyringOf(ctx);
      return Response.json(keyring ? await keyring.jwks() : { keys: [] }, {
        headers: { 'cache-control': 'no-store' },
      });
    },
  });
}
