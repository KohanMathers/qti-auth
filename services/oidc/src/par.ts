import { randomUUIDv7 } from 'node:crypto';

import { type ClientRecord, findClientById, isSuspended, redirectAllowed } from './clients.ts';
import { readForm } from './form.ts';
import { oidcMetrics } from './metrics.ts';
import {
  addMs,
  authenticateClient,
  type AuthorizeQuery,
  CODE_CHALLENGE,
  oauthJson,
} from './oauth-core.ts';
import { parseScopeString, requestedScopes } from './scopes.ts';
import type { Context } from './service.ts';
import { hashToken, newToken } from './tokens.ts';

export const REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:';

export interface PushedAuthorization {
  client: ClientRecord;
  redirectUri: string;
  scopes: string[];
  state: string | null;
  nonce: string | null;
  codeChallenge: string;
}

function authorizationFromForm(form: Record<string, string>): AuthorizeQuery {
  return {
    client_id: form['client_id'],
    redirect_uri: form['redirect_uri'],
    response_type: form['response_type'],
    scope: form['scope'],
    state: form['state'],
    nonce: form['nonce'],
    code_challenge: form['code_challenge'],
    code_challenge_method: form['code_challenge_method'],
  };
}

export function readAuthorizationParams(
  client: ClientRecord,
  query: AuthorizeQuery,
  configured: Context['config']['oidc']['scopes'],
): PushedAuthorization | { error: string; description?: string } {
  const redirectUri = query.redirect_uri ?? '';
  if (!redirectAllowed(client, redirectUri)) {
    return { error: 'invalid_request', description: 'Unknown client or redirect_uri' };
  }
  if (query.response_type !== 'code') return { error: 'unsupported_response_type' };
  if (query.code_challenge_method !== 'S256' || query.code_challenge === undefined) {
    return { error: 'invalid_request', description: 'PKCE S256 is required' };
  }
  if (!CODE_CHALLENGE.test(query.code_challenge)) {
    return { error: 'invalid_request', description: 'code_challenge is not valid' };
  }
  const parsed = parseScopeString(query.scope);
  if (parsed === undefined) return { error: 'invalid_scope' };
  const scopes = requestedScopes(parsed, configured, client.allowed_scopes);
  if (scopes === undefined) return { error: 'invalid_scope' };
  return {
    client,
    redirectUri,
    scopes,
    state: query.state ?? null,
    nonce: query.nonce ?? null,
    codeChallenge: query.code_challenge,
  };
}

export async function pushAuthorization(
  ctx: Context,
  request: Request,
  now = new Date(),
): Promise<Response> {
  const form = await readForm(request);
  const authenticated = await authenticateClient(ctx, request, form, now);
  if ('error' in authenticated) {
    oidcMetrics(ctx.metrics).authorization('public', 'error');
    return authenticated.error;
  }
  const { client } = authenticated;
  const params = readAuthorizationParams(
    client,
    authorizationFromForm(form),
    ctx.config.oidc.scopes,
  );
  if ('error' in params) {
    oidcMetrics(ctx.metrics).authorization(client.type, 'error');
    return oauthJson(params.error, params.description);
  }
  const handle = newToken();
  await ctx.db
    .insertInto('pushed_authorization_requests')
    .values({
      id: randomUUIDv7(),
      request_uri_hash: hashToken(handle),
      client_id: client.id,
      redirect_uri: params.redirectUri,
      scopes: params.scopes,
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.codeChallenge,
      expires_at: addMs(now, ctx.config.oidc.pushed_authorization_ttl),
      consumed_at: null,
      created_at: now,
    })
    .execute();
  return Response.json(
    {
      request_uri: `${REQUEST_URI_PREFIX}${handle}`,
      expires_in: Math.floor(ctx.config.oidc.pushed_authorization_ttl / 1000),
    },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  );
}

export async function takePushedRequest(
  ctx: Context,
  client: ClientRecord,
  requestUri: string,
  now: Date,
): Promise<PushedAuthorization | undefined> {
  if (!requestUri.startsWith(REQUEST_URI_PREFIX)) return undefined;
  const handle = requestUri.slice(REQUEST_URI_PREFIX.length);
  if (handle === '') return undefined;
  const row = await ctx.db
    .selectFrom('pushed_authorization_requests')
    .selectAll()
    .where('request_uri_hash', '=', hashToken(handle))
    .executeTakeFirst();
  if (row?.client_id !== client.id || row.consumed_at !== null || row.expires_at <= now) {
    return undefined;
  }
  await ctx.db
    .updateTable('pushed_authorization_requests')
    .set({ consumed_at: now })
    .where('id', '=', row.id)
    .where('consumed_at', 'is', null)
    .execute();
  const stored = await findClientById(ctx.db, row.client_id);
  if (!stored || isSuspended(stored, now)) return undefined;
  return {
    client: stored,
    redirectUri: row.redirect_uri,
    scopes: row.scopes,
    state: row.state,
    nonce: row.nonce,
    codeChallenge: row.code_challenge,
  };
}

export function extraAuthorizeParams(query: AuthorizeQuery): boolean {
  return (
    query.redirect_uri !== undefined ||
    query.response_type !== undefined ||
    query.scope !== undefined ||
    query.state !== undefined ||
    query.nonce !== undefined ||
    query.code_challenge !== undefined ||
    query.code_challenge_method !== undefined
  );
}
