import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import {
  type ConnectedApp,
  type DecideAppApprovalResponse,
  type PendingAppApproval,
} from '@qtiauth/service-kit';
import type { Kysely, Transaction } from 'kysely';

import { type ClientRecord, findClientById, isSuspended } from './clients.ts';
import type { Database, DeviceAuthorizationStatus } from './database.ts';
import {
  type AuthorizationGrantedData,
  type AuthorizationGuardianRequestedData,
  authorizationGrantedEvent,
  authorizationGuardianRequestedEvent,
  type ClientAuthorizedData,
  clientAuthorizedEvent,
} from './events.ts';
import { iso } from './iso.ts';
import { oidcMetrics } from './metrics.ts';
import { addMs, GUARDIAN_APPROVAL_TTL, loadUser, storeConsent } from './oauth-core.ts';
import type { Context } from './service.ts';

export async function childHasGuardians(ctx: Context, userId: string): Promise<boolean> {
  const user = await loadUser(ctx, userId);
  return user?.has_guardians === true;
}

export async function listPendingAppApprovals(
  db: Kysely<Database>,
  userId: string,
  now = new Date(),
): Promise<PendingAppApproval[]> {
  const [requests, devices] = await Promise.all([
    db
      .selectFrom('authorization_requests')
      .innerJoin('clients', 'clients.id', 'authorization_requests.client_id')
      .select([
        'authorization_requests.id as id',
        'clients.client_id as client_id',
        'clients.name as name',
        'authorization_requests.scopes as scopes',
        'authorization_requests.created_at as created_at',
      ])
      .where('authorization_requests.user_id', '=', userId)
      .where('authorization_requests.guardian_status', '=', 'pending')
      .where('authorization_requests.completed_at', 'is', null)
      .where('authorization_requests.expires_at', '>', now)
      .execute(),
    db
      .selectFrom('device_authorizations')
      .innerJoin('clients', 'clients.id', 'device_authorizations.client_id')
      .select([
        'device_authorizations.id as id',
        'clients.client_id as client_id',
        'clients.name as name',
        'device_authorizations.scopes as scopes',
        'device_authorizations.created_at as created_at',
      ])
      .where('device_authorizations.user_id', '=', userId)
      .where('device_authorizations.status', '=', 'pending_guardian')
      .where('device_authorizations.consumed_at', 'is', null)
      .where('device_authorizations.expires_at', '>', now)
      .execute(),
  ]);
  return [...requests, ...devices]
    .map((row) => ({
      id: row.id,
      client_id: row.client_id,
      name: row.name,
      scopes: row.scopes,
      created_at: iso(row.created_at) ?? row.created_at.toISOString(),
    }))
    .sort((left, right) => {
      const byTime = right.created_at.localeCompare(left.created_at);
      return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
    });
}

export async function listConnectedApps(
  db: Kysely<Database>,
  options: { userId: string; since: Date; until: Date },
): Promise<ConnectedApp[]> {
  const rows = await db
    .selectFrom('consents')
    .innerJoin('clients', 'clients.id', 'consents.client_id')
    .select([
      'clients.client_id as client_id',
      'clients.name as name',
      'consents.granted_at as granted_at',
    ])
    .where('consents.user_id', '=', options.userId)
    .where('consents.granted_at', '>=', options.since)
    .where('consents.granted_at', '<=', options.until)
    .orderBy('consents.granted_at', 'desc')
    .orderBy('clients.client_id', 'desc')
    .execute();
  return rows.map((row) => ({
    client_id: row.client_id,
    name: row.name,
    granted_at: iso(row.granted_at) ?? row.granted_at.toISOString(),
  }));
}

export async function beginGuardianAuthorization(
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
    amr: readonly string[];
    acr: string;
    now: Date;
  },
): Promise<string> {
  const existing = await ctx.db
    .selectFrom('authorization_requests')
    .select(['id', 'expires_at'])
    .where('user_id', '=', options.userId)
    .where('client_id', '=', options.client.id)
    .where('guardian_status', '=', 'pending')
    .where('completed_at', 'is', null)
    .executeTakeFirst();
  if (existing && existing.expires_at > options.now) {
    await ctx.db
      .updateTable('authorization_requests')
      .set({
        session_id: options.sessionId,
        redirect_uri: options.redirectUri,
        scopes: [...options.scopes],
        state: options.state,
        nonce: options.nonce,
        code_challenge: options.codeChallenge,
        auth_time: options.now,
        amr: [...options.amr],
        acr: options.acr,
        expires_at: addMs(options.now, GUARDIAN_APPROVAL_TTL),
      })
      .where('id', '=', existing.id)
      .execute();
    return existing.id;
  }
  if (existing) {
    await ctx.db
      .updateTable('authorization_requests')
      .set({ guardian_status: 'declined', completed_at: options.now })
      .where('id', '=', existing.id)
      .where('guardian_status', '=', 'pending')
      .execute();
  }
  const requestId = randomUUIDv7();
  try {
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('authorization_requests')
        .values({
          id: requestId,
          client_id: options.client.id,
          user_id: options.userId,
          session_id: options.sessionId,
          redirect_uri: options.redirectUri,
          scopes: [...options.scopes],
          state: options.state,
          nonce: options.nonce,
          code_challenge: options.codeChallenge,
          auth_time: options.now,
          amr: [...options.amr],
          acr: options.acr,
          expires_at: addMs(options.now, GUARDIAN_APPROVAL_TTL),
          completed_at: null,
          guardian_status: 'pending',
          created_at: options.now,
        })
        .execute();
      await writeEvent<Database, AuthorizationGuardianRequestedData>(
        trx,
        authorizationGuardianRequestedEvent(options.userId, {
          client_id: options.client.client_id,
          client_name: options.client.name,
          client_type: options.client.type,
          scopes: [...options.scopes],
          request_id: requestId,
        }),
      );
    });
    ctx.outbox.wake();
    return requestId;
  } catch {
    const raced = await ctx.db
      .selectFrom('authorization_requests')
      .select('id')
      .where('user_id', '=', options.userId)
      .where('client_id', '=', options.client.id)
      .where('guardian_status', '=', 'pending')
      .where('expires_at', '>', options.now)
      .executeTakeFirst();
    if (raced) return raced.id;
    throw new Error('Could not create a guardian authorization request');
  }
}

export async function holdDeviceForGuardian(
  ctx: Context,
  options: {
    rowId: string;
    client: ClientRecord;
    userId: string;
    sessionId: string;
    scopes: readonly string[];
    amr: readonly string[];
    acr: string;
    now: Date;
  },
): Promise<boolean> {
  const updated = await ctx.db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('device_authorizations')
      .set({
        status: 'pending_guardian' satisfies DeviceAuthorizationStatus,
        user_id: options.userId,
        session_id: options.sessionId,
        auth_time: options.now,
        amr: [...options.amr],
        acr: options.acr,
        expires_at: addMs(options.now, GUARDIAN_APPROVAL_TTL),
      })
      .where('id', '=', options.rowId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) return false;
    await writeEvent<Database, AuthorizationGuardianRequestedData>(
      trx,
      authorizationGuardianRequestedEvent(options.userId, {
        client_id: options.client.client_id,
        client_name: options.client.name,
        client_type: options.client.type,
        scopes: [...options.scopes],
        request_id: options.rowId,
      }),
    );
    return true;
  });
  if (updated) ctx.outbox.wake();
  return updated;
}

async function decideAuthorizationRequest(
  ctx: Context,
  options: { userId: string; requestId: string; approve: boolean; now: Date },
): Promise<DecideAppApprovalResponse['status'] | undefined> {
  const row = await ctx.db
    .selectFrom('authorization_requests')
    .selectAll()
    .where('id', '=', options.requestId)
    .where('user_id', '=', options.userId)
    .where('guardian_status', '=', 'pending')
    .where('completed_at', 'is', null)
    .executeTakeFirst();
  if (!row) return undefined;
  if (row.expires_at <= options.now) {
    await ctx.db
      .updateTable('authorization_requests')
      .set({ guardian_status: 'declined', completed_at: options.now })
      .where('id', '=', row.id)
      .where('guardian_status', '=', 'pending')
      .execute();
    return 'not_found';
  }
  if (options.approve) {
    await ctx.db
      .updateTable('authorization_requests')
      .set({ guardian_status: 'approved' })
      .where('id', '=', row.id)
      .where('guardian_status', '=', 'pending')
      .execute();
    return 'approved';
  }
  const client = await findClientById(ctx.db, row.client_id);
  await ctx.db
    .updateTable('authorization_requests')
    .set({ guardian_status: 'declined', completed_at: options.now })
    .where('id', '=', row.id)
    .where('guardian_status', '=', 'pending')
    .execute();
  oidcMetrics(ctx.metrics).authorization(client?.type ?? 'public', 'denied');
  return 'declined';
}

async function decideDeviceRequest(
  ctx: Context,
  options: { userId: string; requestId: string; approve: boolean; now: Date },
): Promise<DecideAppApprovalResponse['status'] | undefined> {
  const row = await ctx.db
    .selectFrom('device_authorizations')
    .selectAll()
    .where('id', '=', options.requestId)
    .where('user_id', '=', options.userId)
    .where('status', '=', 'pending_guardian')
    .where('consumed_at', 'is', null)
    .executeTakeFirst();
  if (!row) return undefined;
  const client = await findClientById(ctx.db, row.client_id);
  if (!client || isSuspended(client, options.now) || row.expires_at <= options.now) {
    await ctx.db
      .updateTable('device_authorizations')
      .set({ status: 'denied' satisfies DeviceAuthorizationStatus, consumed_at: options.now })
      .where('id', '=', row.id)
      .where('status', '=', 'pending_guardian')
      .execute();
    oidcMetrics(ctx.metrics).deviceApproval('denied');
    oidcMetrics(ctx.metrics).authorization(client?.type ?? 'public', 'denied');
    return 'not_found';
  }
  if (!options.approve) {
    await ctx.db
      .updateTable('device_authorizations')
      .set({ status: 'denied' satisfies DeviceAuthorizationStatus, consumed_at: options.now })
      .where('id', '=', row.id)
      .where('status', '=', 'pending_guardian')
      .execute();
    oidcMetrics(ctx.metrics).deviceApproval('denied');
    oidcMetrics(ctx.metrics).authorization(client.type, 'denied');
    return 'declined';
  }
  const sessionId = row.session_id;
  const authTime = row.auth_time;
  const amr = row.amr;
  const acr = row.acr;
  if (sessionId === null || authTime === null || amr === null || acr === null) {
    return 'not_found';
  }
  await ctx.db.transaction().execute(async (trx: Transaction<Database>) => {
    const consent = await storeConsent(trx, {
      userId: options.userId,
      clientId: client.id,
      scopes: row.scopes,
      now: options.now,
    });
    await trx
      .updateTable('device_authorizations')
      .set({ status: 'authorized' satisfies DeviceAuthorizationStatus })
      .where('id', '=', row.id)
      .where('status', '=', 'pending_guardian')
      .execute();
    const actor = { type: 'user' as const, id: options.userId };
    await writeEvent<Database, AuthorizationGrantedData>(
      trx,
      authorizationGrantedEvent(
        options.userId,
        {
          client_id: client.client_id,
          client_type: client.type,
          scopes: [...row.scopes],
        },
        actor,
      ),
    );
    if (consent.created) {
      await writeEvent<Database, ClientAuthorizedData>(
        trx,
        clientAuthorizedEvent(
          options.userId,
          {
            client_id: client.client_id,
            client_name: client.name,
            client_type: client.type,
            scopes: [...row.scopes],
          },
          actor,
        ),
      );
    }
  });
  ctx.outbox.wake();
  oidcMetrics(ctx.metrics).deviceApproval('granted');
  oidcMetrics(ctx.metrics).authorization(client.type, 'granted');
  return 'approved';
}

export async function decideAppApproval(
  ctx: Context,
  options: { userId: string; requestId: string; approve: boolean; now?: Date },
): Promise<DecideAppApprovalResponse> {
  const now = options.now ?? new Date();
  const authorization = await decideAuthorizationRequest(ctx, { ...options, now });
  if (authorization !== undefined) return { status: authorization };
  const device = await decideDeviceRequest(ctx, { ...options, now });
  if (device !== undefined) return { status: device };
  return { status: 'not_found' };
}
