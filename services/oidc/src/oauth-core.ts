import { randomUUIDv7 } from 'node:crypto';

import { rpcRequest } from '@qtiauth/bus';
import {
  type UserClaims,
  USER_CLAIMS_METHOD,
  USER_CLAIMS_SERVICE,
  userClaimsResponseSchema,
} from '@qtiauth/service-kit';
import type { Transaction } from 'kysely';

import { userinfoClaims } from './claims.ts';
import { type ClientRecord, findClient, isSuspended, secretChecksOut } from './clients.ts';
import type { Database } from './database.ts';
import { presentedCredentials } from './form.ts';
import { ACCESS_TOKEN_TYPE, atHash, ID_TOKEN_TYPE, signJwt } from './jwt.ts';
import { keyringOf } from './keys.ts';
import { includesOfflineAccess, includesOpenId } from './scopes.ts';
import type { Context } from './service.ts';
import { issuerUrl, resourceAudience } from './settings.ts';
import { hashToken, newToken } from './tokens.ts';

export const AUTHORIZATION_REQUEST_TTL = 10 * 60 * 1000;
export const GUARDIAN_APPROVAL_TTL = 24 * 60 * 60 * 1000;
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export interface AuthorizeQuery {
  client_id?: string | undefined;
  redirect_uri?: string | undefined;
  response_type?: string | undefined;
  scope?: string | undefined;
  state?: string | undefined;
  nonce?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
  request_uri?: string | undefined;
}

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

export function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export function childAccount(ageBand: string | null): boolean {
  return ageBand !== null && ageBand !== 'adult';
}

export async function loadUser(ctx: Context, userId: string): Promise<UserClaims | null> {
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

export async function authenticateClient(
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

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope: string;
}

export async function issueTokens(
  ctx: Context,
  trx: Transaction<Database>,
  options: {
    client: ClientRecord;
    user: UserClaims | null;
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
  const subject = options.user?.id ?? options.client.client_id;
  let refreshId: string | null = null;
  let refreshToken: string | undefined;
  if (options.user !== null && includesOfflineAccess(options.scopes)) {
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
      user_id: options.user?.id ?? null,
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
      sub: subject,
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
  if (options.user !== null && includesOpenId(options.scopes)) {
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

export async function storeConsent(
  trx: Transaction<Database>,
  options: { userId: string; clientId: string; scopes: readonly string[]; now: Date },
): Promise<{ created: boolean }> {
  const existing = await trx
    .selectFrom('consents')
    .select('client_id')
    .where('user_id', '=', options.userId)
    .where('client_id', '=', options.clientId)
    .executeTakeFirst();
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
  return { created: existing === undefined };
}
