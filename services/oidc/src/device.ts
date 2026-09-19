import { randomBytes, randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { Identity } from '@qtiauth/service-kit';
import type { Selectable } from 'kysely';

import { type ClientRecord, findClientById, isSuspended } from './clients.ts';
import type { Database, DeviceAuthorizationStatus } from './database.ts';
import { type AuthorizationGrantedData, authorizationGrantedEvent } from './events.ts';
import { readForm } from './form.ts';
import { oidcMetrics } from './metrics.ts';
import {
  addMs,
  authenticateClient,
  childAccount,
  issueTokens,
  loadUser,
  oauthJson,
  storeConsent,
} from './oauth-core.ts';
import { parseScopeString, requestedScopes } from './scopes.ts';
import type { Context } from './service.ts';
import { issuerUrl, surfaceOrigin } from './settings.ts';
import { hashToken, newToken } from './tokens.ts';

export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;
const SLOW_DOWN_STEP_MS = 5_000;

export type DeviceAuthorizationRow = Selectable<Database['device_authorizations']>;

export type DeviceDecision = { status: 'not_found' } | { status: 'denied' } | { status: 'granted' };

export function newUserCode(): string {
  const bytes = randomBytes(USER_CODE_LENGTH);
  let raw = '';
  for (const byte of bytes) raw += USER_CODE_ALPHABET.charAt(byte % USER_CODE_ALPHABET.length);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeUserCode(value: string): string | undefined {
  const normalized = value.replaceAll(/[\s-]/g, '').toUpperCase();
  if (normalized.length !== USER_CODE_LENGTH) return undefined;
  for (const character of normalized) {
    if (!USER_CODE_ALPHABET.includes(character)) return undefined;
  }
  return normalized;
}

export function displayUserCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

function verificationUri(ctx: Context): string {
  const origin = surfaceOrigin(ctx.config, 'account') ?? issuerUrl(ctx.config);
  return `${origin.replace(/\/+$/, '')}/oauth/device`;
}

export async function startDeviceAuthorization(
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
  const parsed = parseScopeString(form['scope']);
  if (parsed === undefined) {
    oidcMetrics(ctx.metrics).authorization(client.type, 'error');
    return oauthJson('invalid_scope');
  }
  const scopes = requestedScopes(parsed, ctx.config.oidc.scopes, client.allowed_scopes);
  if (scopes === undefined) {
    oidcMetrics(ctx.metrics).authorization(client.type, 'error');
    return oauthJson('invalid_scope');
  }
  const deviceCode = newToken();
  let userCode = newUserCode();
  const expires = addMs(now, ctx.config.oidc.device_code_ttl);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const normalized = normalizeUserCode(userCode);
    if (normalized === undefined) {
      userCode = newUserCode();
      continue;
    }
    try {
      await ctx.db
        .insertInto('device_authorizations')
        .values({
          id: randomUUIDv7(),
          device_code_hash: hashToken(deviceCode),
          user_code_hash: hashToken(normalized),
          client_id: client.id,
          scopes,
          interval_ms: ctx.config.oidc.device_interval,
          last_polled_at: null,
          status: 'pending',
          user_id: null,
          session_id: null,
          auth_time: null,
          amr: null,
          acr: null,
          expires_at: expires,
          consumed_at: null,
          created_at: now,
        })
        .execute();
      const uri = verificationUri(ctx);
      return Response.json(
        {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: uri,
          verification_uri_complete: `${uri}?user_code=${encodeURIComponent(userCode)}`,
          expires_in: Math.floor(ctx.config.oidc.device_code_ttl / 1000),
          interval: Math.floor(ctx.config.oidc.device_interval / 1000),
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch {
      userCode = newUserCode();
    }
  }
  oidcMetrics(ctx.metrics).authorization(client.type, 'error');
  return oauthJson('server_error', 'Could not issue a device code', 503);
}

export async function loadDeviceAuthorization(
  ctx: Context,
  userCode: string,
  now = new Date(),
): Promise<{ row: DeviceAuthorizationRow; client: ClientRecord } | undefined> {
  const normalized = normalizeUserCode(userCode);
  if (normalized === undefined) return undefined;
  const row = await ctx.db
    .selectFrom('device_authorizations')
    .selectAll()
    .where('user_code_hash', '=', hashToken(normalized))
    .executeTakeFirst();
  if (row?.status !== 'pending' || row.expires_at <= now || row.consumed_at !== null) {
    return undefined;
  }
  const client = await findClientById(ctx.db, row.client_id);
  if (!client || isSuspended(client, now)) return undefined;
  return { row, client };
}

export async function decideDeviceAuthorization(
  ctx: Context,
  identity: Identity,
  form: Record<string, string>,
  now = new Date(),
): Promise<DeviceDecision> {
  const userId = identity.sub;
  const sessionId = identity.sid;
  const loaded = await loadDeviceAuthorization(ctx, form['user_code'] ?? '', now);
  if (!loaded || userId === null || sessionId === null) return { status: 'not_found' };
  const { row, client } = loaded;
  if (form['decision'] !== 'allow') {
    await ctx.db
      .updateTable('device_authorizations')
      .set({ status: 'denied' satisfies DeviceAuthorizationStatus, consumed_at: now })
      .where('id', '=', row.id)
      .where('status', '=', 'pending')
      .execute();
    oidcMetrics(ctx.metrics).deviceApproval('denied');
    oidcMetrics(ctx.metrics).authorization(client.type, 'denied');
    return { status: 'denied' };
  }
  if (childAccount(identity.age_band) && !client.first_party) {
    await ctx.db
      .updateTable('device_authorizations')
      .set({ status: 'denied' satisfies DeviceAuthorizationStatus, consumed_at: now })
      .where('id', '=', row.id)
      .where('status', '=', 'pending')
      .execute();
    oidcMetrics(ctx.metrics).deviceApproval('denied');
    oidcMetrics(ctx.metrics).authorization(client.type, 'denied');
    return { status: 'denied' };
  }
  await ctx.db.transaction().execute(async (trx) => {
    await storeConsent(trx, {
      userId,
      clientId: client.id,
      scopes: row.scopes,
      now,
    });
    await trx
      .updateTable('device_authorizations')
      .set({
        status: 'authorized' satisfies DeviceAuthorizationStatus,
        user_id: userId,
        session_id: sessionId,
        auth_time: now,
        amr: [...identity.amr],
        acr: identity.acr ?? 'aal1',
      })
      .where('id', '=', row.id)
      .where('status', '=', 'pending')
      .execute();
    await writeEvent<Database, AuthorizationGrantedData>(
      trx,
      authorizationGrantedEvent(
        userId,
        {
          client_id: client.client_id,
          client_type: client.type,
          scopes: [...row.scopes],
        },
        { type: 'user', id: userId },
      ),
    );
  });
  ctx.outbox.wake();
  oidcMetrics(ctx.metrics).deviceApproval('granted');
  oidcMetrics(ctx.metrics).authorization(client.type, 'granted');
  return { status: 'granted' };
}

export async function deviceGrant(
  ctx: Context,
  client: ClientRecord,
  form: Record<string, string>,
  now: Date,
): Promise<Response> {
  const presented = form['device_code'] ?? '';
  const row = await ctx.db
    .selectFrom('device_authorizations')
    .selectAll()
    .where('device_code_hash', '=', hashToken(presented))
    .executeTakeFirst();
  if (row?.client_id !== client.id) {
    oidcMetrics(ctx.metrics).tokenGrant('device_code', 'error');
    return oauthJson('invalid_grant');
  }
  if (row.expires_at <= now || row.consumed_at !== null) {
    oidcMetrics(ctx.metrics).tokenGrant('device_code', 'error');
    return oauthJson('expired_token');
  }
  if (row.status === 'denied') {
    oidcMetrics(ctx.metrics).tokenGrant('device_code', 'error');
    return oauthJson('access_denied');
  }
  const interval = row.interval_ms;
  if (row.last_polled_at !== null && now.getTime() - row.last_polled_at.getTime() < interval) {
    await ctx.db
      .updateTable('device_authorizations')
      .set({ interval_ms: interval + SLOW_DOWN_STEP_MS, last_polled_at: now })
      .where('id', '=', row.id)
      .execute();
    oidcMetrics(ctx.metrics).tokenGrant('device_code', 'error');
    return oauthJson('slow_down');
  }
  await ctx.db
    .updateTable('device_authorizations')
    .set({ last_polled_at: now })
    .where('id', '=', row.id)
    .execute();
  if (row.status === 'pending') {
    oidcMetrics(ctx.metrics).tokenGrant('device_code', 'error');
    return oauthJson('authorization_pending');
  }
  const userId = row.user_id;
  const sessionId = row.session_id;
  const authTime = row.auth_time;
  const amr = row.amr;
  const acr = row.acr;
  if (userId === null || sessionId === null || authTime === null || amr === null || acr === null) {
    oidcMetrics(ctx.metrics).tokenGrant('device_code', 'error');
    return oauthJson('invalid_grant');
  }
  const user = await loadUser(ctx, userId);
  if (!user) {
    oidcMetrics(ctx.metrics).tokenGrant('device_code', 'error');
    return oauthJson('invalid_grant');
  }
  const tokens = await ctx.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('device_authorizations')
      .set({ consumed_at: now })
      .where('id', '=', row.id)
      .where('consumed_at', 'is', null)
      .execute();
    return issueTokens(ctx, trx, {
      client,
      user,
      scopes: row.scopes,
      sessionId,
      nonce: null,
      authTime,
      amr,
      acr,
      now,
    });
  });
  ctx.outbox.wake();
  oidcMetrics(ctx.metrics).tokenGrant('device_code', 'success');
  return Response.json(tokens, { headers: { 'cache-control': 'no-store' } });
}
