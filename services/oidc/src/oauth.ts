import { randomUUIDv7 } from 'node:crypto';

import { rpcRequest, writeEvent } from '@qtiauth/bus';
import { deletedRows } from '@qtiauth/db';
import {
  type Identity,
  type ResolvedAccessToken,
  type UserClaims,
  USER_CLAIMS_METHOD,
  USER_CLAIMS_SERVICE,
  userClaimsResponseSchema,
} from '@qtiauth/service-kit';
import type { Kysely, Transaction } from 'kysely';

import { userinfoClaims } from './claims.ts';
import {
  type ClientRecord,
  findClient,
  findClientById,
  isSuspended,
  redirectAllowed,
  secretChecksOut,
} from './clients.ts';
import type { Database } from './database.ts';
import {
  type AuthorizationGrantedData,
  authorizationGrantedEvent,
  type RefreshReuseDetectedData,
  refreshReuseDetectedEvent,
} from './events.ts';
import { presentedCredentials, readForm } from './form.ts';
import {
  ACCESS_TOKEN_TYPE,
  atHash,
  ID_TOKEN_TYPE,
  publicKeyFromJwk,
  signJwt,
  verifyJwt,
} from './jwt.ts';
import { keyringOf } from './keys.ts';
import { oidcMetrics } from './metrics.ts';
import { pkceMatches } from './pkce.ts';
import {
  includesOfflineAccess,
  includesOpenId,
  missingConsent,
  parseScopeString,
  requestedScopes,
} from './scopes.ts';
import type { Context } from './service.ts';
import { issuerUrl, resourceAudience } from './settings.ts';
import { hashToken, newToken } from './tokens.ts';

export const AUTHORIZATION_REQUEST_TTL = 10 * 60 * 1000;
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export function oauthJson(
  error: string,
  description?: string,
  status = 400,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error, ...(description === undefined ? {} : { error_description: description }) },
    {
      status,
      headers: { ...headers, 'cache-control': 'no-store' },
    },
  );
}

export function authorizationRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
): Response {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return new Response(null, { status: 302, headers: { location: url.toString() } });
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

function childAccount(ageBand: string | null): boolean {
  return ageBand !== null && ageBand !== 'adult';
}

async function loadUser(ctx: Context, userId: string): Promise<UserClaims | null> {
  const result = await rpcRequest(
    ctx.bus,
    USER_CLAIMS_SERVICE,
    USER_CLAIMS_METHOD,
    {
      user_id: userId,
    },
    { metrics: ctx.busMetrics },
  );
  if (result.status !== 'ok') return null;
  const parsed = userClaimsResponseSchema.safeParse(result.data);
  return parsed.success ? parsed.data.user : null;
}

async function authenticateClient(
  ctx: Context,
  request: Request,
  form: Record<string, string>,
  now: Date,
): Promise<{ client: ClientRecord & { secret_hash: string | null } } | { error: Response }> {
  const credentials = presentedCredentials(request, form);
  if (credentials === undefined) {
    return { error: oauthJson('invalid_client', 'Client authentication failed', 401) };
  }
  const client = await findClient(ctx.db, credentials.client_id);
  if (!client || isSuspended(client, now) || !secretChecksOut(client, credentials.client_secret)) {
    return {
      error: oauthJson('invalid_client', 'Client authentication failed', 401, {
        'www-authenticate': 'Basic realm="oauth"',
      }),
    };
  }
  return { client };
}

interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope: string;
}

async function issueTokens(
  ctx: Context,
  trx: Transaction<Database>,
  options: {
    client: ClientRecord;
    user: UserClaims;
    scopes: readonly string[];
    sessionId: string | null;
    nonce: string | null;
    authTime: Date;
    amr: readonly string[];
    acr: string;
    familyId?: string;
    now: Date;
  },
): Promise<IssuedTokens> {
  const keyring = keyringOf(ctx);
  if (!keyring) throw new Error('OIDC signing keys are not loaded');
  const signing = keyring.signingKey();
  const algorithm = ctx.config.oidc.signing.algorithm;
  const issuer = issuerUrl(ctx.config);
  const audience = resourceAudience(ctx.config);
  const now = options.now;
  const accessExpires = addMs(now, ctx.config.oidc.access_ttl);
  const idExpires = addMs(now, ctx.config.oidc.id_ttl);
  const refreshExpires = addMs(now, ctx.config.oidc.refresh_ttl);
  const accessId = randomUUIDv7();
  let refreshId: string | null = null;
  let refreshToken: string | undefined;
  if (includesOfflineAccess(options.scopes)) {
    refreshId = randomUUIDv7();
    refreshToken = newToken();
    await trx
      .insertInto('refresh_tokens')
      .values({
        id: refreshId,
        token_hash: hashToken(refreshToken),
        family_id: options.familyId ?? refreshId,
        client_id: options.client.id,
        user_id: options.user.id,
        session_id: options.sessionId,
        scopes: [...options.scopes],
        expires_at: refreshExpires,
        rotated_at: null,
        revoked_at: null,
        created_at: now,
      })
      .execute();
  }
  await trx
    .insertInto('access_tokens')
    .values({
      id: accessId,
      client_id: options.client.id,
      user_id: options.user.id,
      session_id: options.sessionId,
      scopes: [...options.scopes],
      amr: [...options.amr],
      acr: options.acr,
      expires_at: accessExpires,
      revoked_at: null,
      refresh_id: refreshId,
      created_at: now,
    })
    .execute();
  const iat = seconds(now);
  const accessToken = signJwt({
    header: { alg: algorithm, typ: ACCESS_TOKEN_TYPE, kid: signing.kid },
    payload: {
      iss: issuer,
      sub: options.user.id,
      aud: audience,
      exp: seconds(accessExpires),
      iat,
      nbf: iat,
      jti: accessId,
      client_id: options.client.client_id,
      scope: options.scopes.join(' '),
      ...(options.sessionId === null ? {} : { sid: options.sessionId }),
    },
    privateKey: signing.privateKey,
  });
  let idToken: string | undefined;
  if (includesOpenId(options.scopes)) {
    idToken = signJwt({
      header: { alg: algorithm, typ: ID_TOKEN_TYPE, kid: signing.kid },
      payload: {
        ...userinfoClaims(options.user, options.scopes, ctx.config.oidc.scopes),
        iss: issuer,
        aud: options.client.client_id,
        exp: seconds(idExpires),
        iat,
        auth_time: seconds(options.authTime),
        at_hash: atHash(accessToken, algorithm),
        amr: [...options.amr],
        acr: options.acr,
        ...(options.nonce === null ? {} : { nonce: options.nonce }),
        ...(options.sessionId === null ? {} : { sid: options.sessionId }),
      },
      privateKey: signing.privateKey,
    });
  }
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.floor(ctx.config.oidc.access_ttl / 1000),
    scope: options.scopes.join(' '),
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    ...(idToken === undefined ? {} : { id_token: idToken }),
  };
}

async function grantedScopes(
  db: Kysely<Database>,
  userId: string,
  clientId: string,
): Promise<string[] | undefined> {
  const row = await db
    .selectFrom('consents')
    .select('scopes')
    .where('user_id', '=', userId)
    .where('client_id', '=', clientId)
    .executeTakeFirst();
  return row?.scopes;
}

async function storeConsent(
  trx: Transaction<Database>,
  options: { userId: string; clientId: string; scopes: readonly string[]; now: Date },
): Promise<void> {
  await trx
    .insertInto('consents')
    .values({
      user_id: options.userId,
      client_id: options.clientId,
      scopes: [...options.scopes],
      granted_at: options.now,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'client_id']).doUpdateSet({
        scopes: [...options.scopes],
        granted_at: options.now,
      }),
    )
    .execute();
}

async function completeAuthorization(
  ctx: Context,
  options: {
    client: ClientRecord;
    userId: string;
    sessionId: string;
    redirectUri: string;
    scopes: readonly string[];
    state: string | null;
    nonce: string | null;
    codeChallenge: string;
    authTime: Date;
    amr: readonly string[];
    acr: string;
    now: Date;
  },
): Promise<Response> {
  const code = newToken();
  await ctx.db.transaction().execute(async (trx: Transaction<Database>) => {
    await storeConsent(trx, {
      userId: options.userId,
      clientId: options.client.id,
      scopes: options.scopes,
      now: options.now,
    });
    await trx
      .insertInto('authorization_codes')
      .values({
        id: randomUUIDv7(),
        code_hash: hashToken(code),
        client_id: options.client.id,
        user_id: options.userId,
        session_id: options.sessionId,
        redirect_uri: options.redirectUri,
        scopes: [...options.scopes],
        nonce: options.nonce,
        code_challenge: options.codeChallenge,
        auth_time: options.authTime,
        amr: [...options.amr],
        acr: options.acr,
        expires_at: addMs(options.now, ctx.config.oidc.authorization_code_ttl),
        consumed_at: null,
        created_at: options.now,
      })
      .execute();
    await writeEvent<Database, AuthorizationGrantedData>(
      trx,
      authorizationGrantedEvent(
        options.userId,
        {
          client_id: options.client.client_id,
          client_type: options.client.type,
          scopes: [...options.scopes],
        },
        { type: 'user', id: options.userId },
      ),
    );
  });
  ctx.outbox.wake();
  oidcMetrics(ctx.metrics).authorization(options.client.type, 'granted');
  return authorizationRedirect(options.redirectUri, {
    code,
    ...(options.state === null ? {} : { state: options.state }),
  });
}

export interface AuthorizeQuery {
  client_id?: string | undefined;
  redirect_uri?: string | undefined;
  response_type?: string | undefined;
  scope?: string | undefined;
  state?: string | undefined;
  nonce?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
}

export async function authorize(
  ctx: Context,
  identity: Identity,
  query: AuthorizeQuery,
  now = new Date(),
): Promise<Response> {
  const clientId = query.client_id ?? '';
  const redirectUri = query.redirect_uri ?? '';
  const client = await findClient(ctx.db, clientId);
  const redirectOk = client !== undefined && redirectAllowed(client, redirectUri);
  if (!client || isSuspended(client, now) || !redirectOk) {
    oidcMetrics(ctx.metrics).authorization(client?.type ?? 'public', 'error');
    return oauthJson('invalid_request', 'Unknown client or redirect_uri');
  }
  const fail = (error: string, description?: string) => {
    oidcMetrics(ctx.metrics).authorization(
      client.type,
      error === 'access_denied' ? 'denied' : 'error',
    );
    return authorizationRedirect(redirectUri, {
      error,
      error_description: description,
      state: query.state,
    });
  };
  if (query.response_type !== 'code') return fail('unsupported_response_type');
  if (query.code_challenge_method !== 'S256' || query.code_challenge === undefined) {
    return fail('invalid_request', 'PKCE S256 is required');
  }
  if (!CODE_CHALLENGE.test(query.code_challenge)) {
    return fail('invalid_request', 'code_challenge is not valid');
  }
  const parsed = parseScopeString(query.scope);
  if (parsed === undefined) return fail('invalid_scope');
  const scopes = requestedScopes(parsed, ctx.config.oidc.scopes, client.allowed_scopes);
  if (scopes === undefined) return fail('invalid_scope');
  if (identity.sub === null || identity.sid === null) {
    return fail('access_denied', 'Sign in is required');
  }
  if (childAccount(identity.age_band) && !client.first_party) {
    return fail('access_denied', 'This app cannot be used with this account yet');
  }
  if (
    client.first_party ||
    missingConsent(scopes, await grantedScopes(ctx.db, identity.sub, client.id)).length === 0
  ) {
    return completeAuthorization(ctx, {
      client,
      userId: identity.sub,
      sessionId: identity.sid,
      redirectUri,
      scopes,
      state: query.state ?? null,
      nonce: query.nonce ?? null,
      codeChallenge: query.code_challenge,
      authTime: now,
      amr: identity.amr,
      acr: identity.acr ?? 'aal1',
      now,
    });
  }
  const requestId = randomUUIDv7();
  await ctx.db
    .insertInto('authorization_requests')
    .values({
      id: requestId,
      client_id: client.id,
      user_id: identity.sub,
      session_id: identity.sid,
      redirect_uri: redirectUri,
      scopes,
      state: query.state ?? null,
      nonce: query.nonce ?? null,
      code_challenge: query.code_challenge,
      auth_time: now,
      amr: [...identity.amr],
      acr: identity.acr ?? 'aal1',
      expires_at: addMs(now, AUTHORIZATION_REQUEST_TTL),
      completed_at: null,
      created_at: now,
    })
    .execute();
  return new Response(null, {
    status: 302,
    headers: { location: `/oauth/consent?request_id=${requestId}` },
  });
}

export async function loadAuthorizationRequest(
  ctx: Context,
  identity: Identity,
  requestId: string,
  now = new Date(),
) {
  if (identity.sub === null) return undefined;
  const row = await ctx.db
    .selectFrom('authorization_requests')
    .selectAll()
    .where('id', '=', requestId)
    .where('user_id', '=', identity.sub)
    .executeTakeFirst();
  if (row?.completed_at !== null || row.expires_at <= now) return undefined;
  const client = await findClientById(ctx.db, row.client_id);
  if (!client || isSuspended(client, now)) return undefined;
  return { row, client };
}

export async function decideConsent(
  ctx: Context,
  identity: Identity,
  form: Record<string, string>,
  now = new Date(),
): Promise<Response | { status: 'not_found' }> {
  const requestId = form['request_id'] ?? '';
  const loaded = await loadAuthorizationRequest(ctx, identity, requestId, now);
  if (!loaded || identity.sid === null || identity.sub === null) return { status: 'not_found' };
  const { row, client } = loaded;
  await ctx.db
    .updateTable('authorization_requests')
    .set({ completed_at: now })
    .where('id', '=', row.id)
    .execute();
  if (form['decision'] !== 'allow') {
    oidcMetrics(ctx.metrics).authorization(client.type, 'denied');
    return authorizationRedirect(row.redirect_uri, {
      error: 'access_denied',
      state: row.state ?? undefined,
    });
  }
  return completeAuthorization(ctx, {
    client,
    userId: identity.sub,
    sessionId: identity.sid,
    redirectUri: row.redirect_uri,
    scopes: row.scopes,
    state: row.state,
    nonce: row.nonce,
    codeChallenge: row.code_challenge,
    authTime: row.auth_time,
    amr: row.amr,
    acr: row.acr,
    now,
  });
}

async function exchangeCode(
  ctx: Context,
  client: ClientRecord,
  form: Record<string, string>,
  now: Date,
): Promise<Response> {
  const code = form['code'] ?? '';
  const redirectUri = form['redirect_uri'] ?? '';
  const verifier = form['code_verifier'] ?? '';
  const row = await ctx.db
    .selectFrom('authorization_codes')
    .selectAll()
    .where('code_hash', '=', hashToken(code))
    .executeTakeFirst();
  if (row?.client_id !== client.id) {
    oidcMetrics(ctx.metrics).tokenGrant('authorization_code', 'error');
    return oauthJson('invalid_grant');
  }
  if (row.consumed_at !== null) {
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('refresh_tokens')
        .set({ revoked_at: now })
        .where('user_id', '=', row.user_id)
        .where('client_id', '=', row.client_id)
        .where('revoked_at', 'is', null)
        .execute();
      await trx
        .updateTable('access_tokens')
        .set({ revoked_at: now })
        .where('user_id', '=', row.user_id)
        .where('client_id', '=', row.client_id)
        .where('revoked_at', 'is', null)
        .execute();
    });
    oidcMetrics(ctx.metrics).tokenGrant('authorization_code', 'error');
    return oauthJson('invalid_grant');
  }
  if (
    row.expires_at <= now ||
    row.redirect_uri !== redirectUri ||
    !pkceMatches(verifier, row.code_challenge)
  ) {
    oidcMetrics(ctx.metrics).tokenGrant('authorization_code', 'error');
    return oauthJson('invalid_grant');
  }
  const user = await loadUser(ctx, row.user_id);
  if (!user) {
    oidcMetrics(ctx.metrics).tokenGrant('authorization_code', 'error');
    return oauthJson('invalid_grant');
  }
  const tokens = await ctx.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('authorization_codes')
      .set({ consumed_at: now })
      .where('id', '=', row.id)
      .execute();
    return issueTokens(ctx, trx, {
      client,
      user,
      scopes: row.scopes,
      sessionId: row.session_id,
      nonce: row.nonce,
      authTime: row.auth_time,
      amr: row.amr,
      acr: row.acr,
      now,
    });
  });
  ctx.outbox.wake();
  oidcMetrics(ctx.metrics).tokenGrant('authorization_code', 'success');
  return Response.json(tokens, { headers: { 'cache-control': 'no-store' } });
}

async function revokeFamily(
  trx: Transaction<Database>,
  familyId: string,
  now: Date,
): Promise<void> {
  const refresh = await trx
    .selectFrom('refresh_tokens')
    .select('id')
    .where('family_id', '=', familyId)
    .execute();
  const ids = refresh.map((row) => row.id);
  await trx
    .updateTable('refresh_tokens')
    .set({ revoked_at: now })
    .where('family_id', '=', familyId)
    .where('revoked_at', 'is', null)
    .execute();
  if (ids.length > 0) {
    await trx
      .updateTable('access_tokens')
      .set({ revoked_at: now })
      .where('refresh_id', 'in', ids)
      .where('revoked_at', 'is', null)
      .execute();
  }
}

async function refreshGrant(
  ctx: Context,
  client: ClientRecord,
  form: Record<string, string>,
  now: Date,
): Promise<Response> {
  const presented = form['refresh_token'] ?? '';
  const row = await ctx.db
    .selectFrom('refresh_tokens')
    .selectAll()
    .where('token_hash', '=', hashToken(presented))
    .executeTakeFirst();
  if (row?.client_id !== client.id) {
    oidcMetrics(ctx.metrics).tokenGrant('refresh_token', 'error');
    return oauthJson('invalid_grant');
  }
  if (row.rotated_at !== null || row.revoked_at !== null) {
    await ctx.db.transaction().execute(async (trx: Transaction<Database>) => {
      await revokeFamily(trx, row.family_id, now);
      await writeEvent<Database, RefreshReuseDetectedData>(
        trx,
        refreshReuseDetectedEvent(row.user_id, {
          client_id: client.client_id,
          family_id: row.family_id,
        }),
      );
    });
    ctx.outbox.wake();
    oidcMetrics(ctx.metrics).refreshReuse();
    oidcMetrics(ctx.metrics).tokenGrant('refresh_token', 'error');
    return oauthJson('invalid_grant');
  }
  if (row.expires_at <= now) {
    oidcMetrics(ctx.metrics).tokenGrant('refresh_token', 'error');
    return oauthJson('invalid_grant');
  }
  let scopes = row.scopes;
  if (form['scope'] !== undefined) {
    const parsed = parseScopeString(form['scope']);
    const narrowed =
      parsed === undefined ? undefined : requestedScopes(parsed, ctx.config.oidc.scopes, scopes);
    if (narrowed === undefined) {
      oidcMetrics(ctx.metrics).tokenGrant('refresh_token', 'error');
      return oauthJson('invalid_scope');
    }
    scopes = narrowed;
  }
  const user = await loadUser(ctx, row.user_id);
  if (!user) {
    oidcMetrics(ctx.metrics).tokenGrant('refresh_token', 'error');
    return oauthJson('invalid_grant');
  }
  const tokens = await ctx.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('refresh_tokens')
      .set({ rotated_at: now, revoked_at: now })
      .where('id', '=', row.id)
      .execute();
    return issueTokens(ctx, trx, {
      client,
      user,
      scopes,
      sessionId: row.session_id,
      nonce: null,
      authTime: now,
      amr: [],
      acr: 'aal1',
      familyId: row.family_id,
      now,
    });
  });
  ctx.outbox.wake();
  oidcMetrics(ctx.metrics).tokenGrant('refresh_token', 'success');
  return Response.json(tokens, { headers: { 'cache-control': 'no-store' } });
}

export async function token(ctx: Context, request: Request, now = new Date()): Promise<Response> {
  const form = await readForm(request);
  const authenticated = await authenticateClient(ctx, request, form, now);
  if ('error' in authenticated) {
    oidcMetrics(ctx.metrics).tokenGrant(
      form['grant_type'] === 'refresh_token' ? 'refresh_token' : 'authorization_code',
      'error',
    );
    return authenticated.error;
  }
  const grant = form['grant_type'];
  if (grant === 'authorization_code') return exchangeCode(ctx, authenticated.client, form, now);
  if (grant === 'refresh_token') return refreshGrant(ctx, authenticated.client, form, now);
  oidcMetrics(ctx.metrics).tokenGrant('authorization_code', 'error');
  return oauthJson('unsupported_grant_type');
}

async function revokeRefresh(
  db: Kysely<Database>,
  tokenHash: string,
  clientId: string,
  now: Date,
): Promise<boolean> {
  const row = await db
    .selectFrom('refresh_tokens')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();
  if (row?.client_id !== clientId) return false;
  await db.transaction().execute((trx) => revokeFamily(trx, row.family_id, now));
  return true;
}

async function revokeAccess(
  db: Kysely<Database>,
  id: string,
  clientId: string,
  now: Date,
): Promise<boolean> {
  const row = await db
    .selectFrom('access_tokens')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (row?.client_id !== clientId) return false;
  await db
    .updateTable('access_tokens')
    .set({ revoked_at: now })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .execute();
  return true;
}

export async function revoke(ctx: Context, request: Request, now = new Date()): Promise<Response> {
  const form = await readForm(request);
  const authenticated = await authenticateClient(ctx, request, form, now);
  if ('error' in authenticated) return new Response(null, { status: 200 });
  const presented = form['token'] ?? '';
  const hint = form['token_type_hint'];
  const hash = hashToken(presented);
  const tryRefresh = () => revokeRefresh(ctx.db, hash, authenticated.client.id, now);
  const tryAccess = async () => {
    const verified = await verifyAccessJwt(ctx, presented, now);
    if (!verified) return false;
    return revokeAccess(ctx.db, verified.jti, authenticated.client.id, now);
  };
  if (hint === 'refresh_token') {
    if (!(await tryRefresh())) await tryAccess();
  } else if (hint === 'access_token') {
    if (!(await tryAccess())) await tryRefresh();
  } else if (!(await tryRefresh())) {
    await tryAccess();
  }
  return new Response(null, { status: 200 });
}

async function verifyAccessJwt(
  ctx: Context,
  presented: string,
  now: Date,
): Promise<{ jti: string; payload: Record<string, unknown> } | undefined> {
  const keyring = keyringOf(ctx);
  if (!keyring) return undefined;
  const jwks = await keyring.jwks();
  const keys = new Map(
    jwks.keys.flatMap((jwk) => {
      const key = publicKeyFromJwk(jwk);
      return key === undefined ? [] : [[jwk.kid, key] as const];
    }),
  );
  const verified = verifyJwt(presented, {
    algorithm: ctx.config.oidc.signing.algorithm,
    typ: ACCESS_TOKEN_TYPE,
    issuer: issuerUrl(ctx.config),
    audience: resourceAudience(ctx.config),
    getKey: (kid) => keys.get(kid),
    now,
  });
  if (!verified) return undefined;
  const jti = verified.payload['jti'];
  if (typeof jti !== 'string' || jti === '') return undefined;
  return { jti, payload: verified.payload };
}

export async function introspect(
  ctx: Context,
  request: Request,
  now = new Date(),
): Promise<Response> {
  const form = await readForm(request);
  const authenticated = await authenticateClient(ctx, request, form, now);
  if ('error' in authenticated) return authenticated.error;
  if (authenticated.client.type !== 'confidential') {
    return oauthJson('invalid_client', 'Introspection requires a confidential client', 401);
  }
  const presented = form['token'] ?? '';
  const hint = form['token_type_hint'];
  const inactive = () => {
    oidcMetrics(ctx.metrics).introspection(false);
    return Response.json({ active: false }, { headers: { 'cache-control': 'no-store' } });
  };
  const refreshHash = hashToken(presented);
  const lookupRefresh = async () => {
    const row = await ctx.db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('token_hash', '=', refreshHash)
      .executeTakeFirst();
    if (
      row?.client_id !== authenticated.client.id ||
      row.revoked_at !== null ||
      row.rotated_at !== null ||
      row.expires_at <= now
    ) {
      return undefined;
    }
    return row;
  };
  if (hint !== 'access_token') {
    const refresh = await lookupRefresh();
    if (refresh) {
      oidcMetrics(ctx.metrics).introspection(true);
      return Response.json(
        {
          active: true,
          token_type: 'refresh_token',
          client_id: authenticated.client.client_id,
          sub: refresh.user_id,
          scope: refresh.scopes.join(' '),
          exp: seconds(refresh.expires_at),
          iat: seconds(refresh.created_at),
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    if (hint === 'refresh_token') return inactive();
  }
  const verified = await verifyAccessJwt(ctx, presented, now);
  if (!verified) return inactive();
  const row = await ctx.db
    .selectFrom('access_tokens')
    .selectAll()
    .where('id', '=', verified.jti)
    .executeTakeFirst();
  if (
    row?.client_id !== authenticated.client.id ||
    row.revoked_at !== null ||
    row.expires_at <= now
  ) {
    return inactive();
  }
  oidcMetrics(ctx.metrics).introspection(true);
  return Response.json(
    {
      active: true,
      token_type: 'Bearer',
      client_id: authenticated.client.client_id,
      sub: row.user_id,
      scope: row.scopes.join(' '),
      exp: seconds(row.expires_at),
      iat: seconds(row.created_at),
      iss: issuerUrl(ctx.config),
      aud: resourceAudience(ctx.config),
      jti: row.id,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function userinfo(ctx: Context, identity: Identity): Promise<Response> {
  if (identity.sub === null)
    return oauthJson('invalid_token', 'The access token is not valid', 401);
  const user = await loadUser(ctx, identity.sub);
  if (!user) return oauthJson('invalid_token', 'The access token is not valid', 401);
  return Response.json(userinfoClaims(user, identity.scopes, ctx.config.oidc.scopes), {
    headers: { 'cache-control': 'no-store' },
  });
}

export async function resolveAccessToken(
  ctx: Context,
  presented: string,
  now = new Date(),
): Promise<ResolvedAccessToken | null> {
  const verified = await verifyAccessJwt(ctx, presented, now);
  if (!verified) return null;
  const row = await ctx.db
    .selectFrom('access_tokens')
    .selectAll()
    .where('id', '=', verified.jti)
    .executeTakeFirst();
  if (row?.revoked_at !== null || row.expires_at <= now) return null;
  const client = await findClientById(ctx.db, row.client_id);
  if (!client || isSuspended(client, now)) return null;
  const user = await loadUser(ctx, row.user_id);
  if (!user || user.account_state === 'deleted') return null;
  return {
    jti: row.id,
    sub: row.user_id,
    client_id: client.client_id,
    scopes: row.scopes,
    sid: row.session_id,
    account_state: user.account_state,
    restrictions: user.restrictions,
    age_band: user.age_band,
    parental_controls: user.parental_controls,
    amr: row.amr,
    acr: row.acr,
  };
}

export async function sweepOauth(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<{
  authorization_requests: number;
  authorization_codes: number;
  refresh_tokens: number;
  access_tokens: number;
}> {
  const cutoff = addMs(options.now, -options.retention);
  const requests = await db
    .deleteFrom('authorization_requests')
    .where('expires_at', '<', cutoff)
    .execute();
  const codes = await db
    .deleteFrom('authorization_codes')
    .where((eb) =>
      eb.or([
        eb('expires_at', '<', cutoff),
        eb.and([eb('consumed_at', 'is not', null), eb('consumed_at', '<', cutoff)]),
      ]),
    )
    .execute();
  const refresh = await db
    .deleteFrom('refresh_tokens')
    .where((eb) =>
      eb.or([
        eb('expires_at', '<', cutoff),
        eb.and([eb('revoked_at', 'is not', null), eb('revoked_at', '<', cutoff)]),
      ]),
    )
    .execute();
  const access = await db
    .deleteFrom('access_tokens')
    .where((eb) =>
      eb.or([
        eb('expires_at', '<', cutoff),
        eb.and([eb('revoked_at', 'is not', null), eb('revoked_at', '<', cutoff)]),
      ]),
    )
    .execute();
  return {
    authorization_requests: deletedRows(requests),
    authorization_codes: deletedRows(codes),
    refresh_tokens: deletedRows(refresh),
    access_tokens: deletedRows(access),
  };
}
