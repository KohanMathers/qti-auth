import { randomUUIDv7 } from 'node:crypto';

import { deletedRows } from '@qtiauth/db';
import { IDENTITY_EVENTS, type EventEnvelope } from '@qtiauth/events';
import type { Logger } from '@qtiauth/observability';
import type { Kysely, Selectable, Transaction } from 'kysely';

import type {
  Database,
  LogoutCause,
  LogoutDeliveriesTable,
  LogoutDeliveryStatus,
} from './database.ts';
import { iso } from './iso.ts';
import { type JwtPayload, LOGOUT_TOKEN_TYPE, signJwt } from './jwt.ts';
import { keyringOf } from './keys.ts';
import { createLogoutHttp, type LogoutHttp } from './logout-http.ts';
import { type OidcMetrics, oidcMetrics } from './metrics.ts';
import { addMs, seconds } from './oauth-core.ts';
import { includesOfflineAccess } from './scopes.ts';
import type { Context } from './service.ts';
import { issuerUrl } from './settings.ts';

export const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
export const RETRY_JOB = 'oidc.logout.retry';
export const LOGOUT_CONSUMER = 'backchannel_logout';
export const LOGOUT_POLL_INTERVAL = 1_000;
const DUE_BATCH = 25;
const MAX_ERROR_LENGTH = 1000;

type SelectableDelivery = Selectable<LogoutDeliveriesTable>;

export interface LogoutQueueConfig {
  timeout: number;
  retry_window: number;
  retry_delay: number;
  max_retry_delay: number;
  allow_private_targets: boolean;
}

export function logoutRetryDelay(attempts: number, config: LogoutQueueConfig): number {
  return Math.min(config.retry_delay * 2 ** Math.max(0, attempts - 1), config.max_retry_delay);
}

export function logoutTokenPayload(options: {
  issuer: string;
  audience: string;
  subject: string;
  sessionId: string;
  jti: string;
  iat: number;
  exp: number;
}): JwtPayload {
  return {
    iss: options.issuer,
    sub: options.subject,
    aud: options.audience,
    iat: options.iat,
    exp: options.exp,
    jti: options.jti,
    sid: options.sessionId,
    events: { [LOGOUT_EVENT]: {} },
  };
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

async function tokenSessions(
  trx: Transaction<Database>,
  options: { userId: string; sessionId?: string },
): Promise<{ client_id: string; session_id: string }[]> {
  let access = trx
    .selectFrom('access_tokens')
    .select(['client_id', 'session_id'])
    .where('user_id', '=', options.userId)
    .where('session_id', 'is not', null);
  let refresh = trx
    .selectFrom('refresh_tokens')
    .select(['client_id', 'session_id'])
    .where('user_id', '=', options.userId)
    .where('session_id', 'is not', null);
  if (options.sessionId !== undefined) {
    access = access.where('session_id', '=', options.sessionId);
    refresh = refresh.where('session_id', '=', options.sessionId);
  }
  const rows = [...(await access.execute()), ...(await refresh.execute())];
  const seen = new Set<string>();
  const out: { client_id: string; session_id: string }[] = [];
  for (const row of rows) {
    if (row.session_id === null) continue;
    const key = `${row.client_id}:${row.session_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ client_id: row.client_id, session_id: row.session_id });
  }
  return out;
}

async function enqueue(
  trx: Transaction<Database>,
  options: {
    clientId: string;
    userId: string;
    sessionId: string;
    uri: string;
    cause: LogoutCause;
    now: Date;
  },
): Promise<void> {
  await trx
    .insertInto('logout_deliveries')
    .values({
      id: randomUUIDv7(),
      client_id: options.clientId,
      user_id: options.userId,
      session_id: options.sessionId,
      uri: options.uri,
      cause: options.cause,
      status: 'retrying',
      attempts: 0,
      next_attempt_at: options.now,
      queued_at: options.now,
      sent_at: null,
      last_error: null,
      response_status: null,
      created_at: options.now,
      updated_at: options.now,
    })
    .execute();
}

async function notifyClients(
  trx: Transaction<Database>,
  options: {
    userId: string;
    sessionId?: string;
    cause: LogoutCause;
    now: Date;
    deliver: boolean;
  },
): Promise<void> {
  if (!options.deliver) return;
  const sessions = await tokenSessions(trx, options);
  if (sessions.length === 0) return;
  const clients = await trx
    .selectFrom('clients')
    .select(['id', 'backchannel_logout_uri', 'backchannel_logout_session_required'])
    .where(
      'id',
      'in',
      sessions.map((row) => row.client_id),
    )
    .execute();
  const byId = new Map(clients.map((client) => [client.id, client]));
  for (const row of sessions) {
    const client = byId.get(row.client_id);
    if (client?.backchannel_logout_uri == null) continue;
    if (client.backchannel_logout_session_required && row.session_id === '') continue;
    await enqueue(trx, {
      clientId: client.id,
      userId: options.userId,
      sessionId: row.session_id,
      uri: client.backchannel_logout_uri,
      cause: options.cause,
      now: options.now,
    });
  }
}

async function revokeAccess(
  trx: Transaction<Database>,
  options: { userId: string; sessionId?: string; now: Date },
): Promise<void> {
  let query = trx
    .updateTable('access_tokens')
    .set({ revoked_at: options.now })
    .where('user_id', '=', options.userId)
    .where('revoked_at', 'is', null);
  if (options.sessionId !== undefined) query = query.where('session_id', '=', options.sessionId);
  await query.execute();
}

async function revokeRefresh(
  trx: Transaction<Database>,
  options: { userId: string; sessionId?: string; now: Date; includeOfflineAccess: boolean },
): Promise<void> {
  const rows = await trx
    .selectFrom('refresh_tokens')
    .select(['id', 'scopes', 'session_id'])
    .where('user_id', '=', options.userId)
    .where('revoked_at', 'is', null)
    .execute();
  const ids = rows
    .filter((row) => {
      if (options.sessionId !== undefined && row.session_id !== options.sessionId) return false;
      return options.includeOfflineAccess || !includesOfflineAccess(row.scopes);
    })
    .map((row) => row.id);
  if (ids.length === 0) return;
  await trx
    .updateTable('refresh_tokens')
    .set({ revoked_at: options.now })
    .where('id', 'in', ids)
    .execute();
}

export async function endSession(
  trx: Transaction<Database>,
  options: { userId: string; sessionId: string; now: Date; deliver: boolean },
): Promise<void> {
  await notifyClients(trx, {
    userId: options.userId,
    sessionId: options.sessionId,
    cause: 'session',
    now: options.now,
    deliver: options.deliver,
  });
  await revokeAccess(trx, options);
  await revokeRefresh(trx, { ...options, includeOfflineAccess: false });
}

export async function endAccount(
  trx: Transaction<Database>,
  options: { userId: string; cause: Exclude<LogoutCause, 'session'>; now: Date; deliver: boolean },
): Promise<void> {
  await notifyClients(trx, options);
  await revokeAccess(trx, options);
  await revokeRefresh(trx, { ...options, includeOfflineAccess: true });
}

export async function handleIdentityEvent(
  trx: Transaction<Database>,
  event: EventEnvelope,
  options: { deliver: boolean; now: Date },
): Promise<void> {
  if (event.type === IDENTITY_EVENTS.sessionRevoked) {
    const data = event.data as { session_id?: unknown; user_id?: unknown };
    if (typeof data.session_id !== 'string' || typeof data.user_id !== 'string') return;
    await endSession(trx, {
      userId: data.user_id,
      sessionId: data.session_id,
      now: options.now,
      deliver: options.deliver,
    });
    return;
  }
  if (event.subject?.type !== 'user') return;
  if (event.type === IDENTITY_EVENTS.userBanned) {
    await endAccount(trx, {
      userId: event.subject.id,
      cause: 'ban',
      now: options.now,
      deliver: options.deliver,
    });
    return;
  }
  if (event.type === IDENTITY_EVENTS.userLocked) {
    await endAccount(trx, {
      userId: event.subject.id,
      cause: 'lock',
      now: options.now,
      deliver: options.deliver,
    });
  }
}

function signLogoutToken(ctx: Context, delivery: SelectableDelivery): string | undefined {
  const keyring = keyringOf(ctx);
  if (!keyring) return undefined;
  const signing = keyring.signingKey();
  const iat = seconds(delivery.queued_at);
  const exp = seconds(addMs(delivery.queued_at, ctx.config.oidc.id_ttl));
  return signJwt({
    header: {
      alg: ctx.config.oidc.signing.algorithm,
      typ: LOGOUT_TOKEN_TYPE,
      kid: signing.kid,
    },
    payload: logoutTokenPayload({
      issuer: issuerUrl(ctx.config),
      audience: delivery.client_id,
      subject: delivery.user_id,
      sessionId: delivery.session_id,
      jti: delivery.id,
      iat,
      exp,
    }),
    privateKey: signing.privateKey,
  });
}

export interface LogoutSenderOptions {
  ctx: Context;
  http?: LogoutHttp;
  log: Logger;
  metrics?: OidcMetrics;
  now?: () => Date;
}

export function createLogoutSender(options: LogoutSenderOptions) {
  const metrics = options.metrics ?? oidcMetrics(options.ctx.metrics);
  const http = options.http ?? createLogoutHttp();
  const nowOf = options.now ?? (() => new Date());
  const config = options.ctx.config.oidc.logout;

  async function attempt(row: SelectableDelivery): Promise<void> {
    const now = nowOf();
    const client = await options.ctx.db
      .selectFrom('clients')
      .select(['client_id', 'backchannel_logout_uri'])
      .where('id', '=', row.client_id)
      .executeTakeFirst();
    if (client?.backchannel_logout_uri == null) {
      await options.ctx.db
        .updateTable('logout_deliveries')
        .set({
          status: 'failed',
          last_error: 'Client has no back-channel logout URI',
          updated_at: now,
        })
        .where('id', '=', row.id)
        .execute();
      metrics.logoutDelivery('failed');
      return;
    }
    const token = signLogoutToken(options.ctx, {
      ...row,
      client_id: client.client_id,
    });
    if (token === undefined) {
      await options.ctx.db
        .updateTable('logout_deliveries')
        .set({
          status: 'retrying',
          attempts: row.attempts + 1,
          next_attempt_at: new Date(now.getTime() + logoutRetryDelay(row.attempts + 1, config)),
          last_error: 'OIDC signing keys are not loaded',
          updated_at: now,
        })
        .where('id', '=', row.id)
        .where('status', '!=', 'sent')
        .execute();
      metrics.logoutDelivery('retrying');
      return;
    }

    const attempts = row.attempts + 1;
    let status: LogoutDeliveryStatus = 'retrying';
    let lastError: string | null = null;
    let responseStatus: number | null = null;
    const started = performance.now();
    try {
      const response = await http({
        url: row.uri,
        token,
        timeout: config.timeout,
        allowPrivate: config.allow_private_targets,
      });
      responseStatus = response.status;
      if (response.status >= 200 && response.status < 300) status = 'sent';
      else lastError = `HTTP ${String(response.status)}`;
    } catch (error) {
      lastError = errorSummary(error);
    }
    metrics.logoutAttempt(status === 'sent' ? 'ok' : 'error', (performance.now() - started) / 1000);
    if (status !== 'sent') {
      const deadline = row.queued_at.getTime() + config.retry_window;
      const next = now.getTime() + logoutRetryDelay(attempts, config);
      if (next > deadline) status = 'failed';
    }
    metrics.logoutDelivery(status);
    await options.ctx.db
      .updateTable('logout_deliveries')
      .set({
        status,
        attempts,
        next_attempt_at:
          status === 'retrying'
            ? new Date(now.getTime() + logoutRetryDelay(attempts, config))
            : null,
        sent_at: status === 'sent' ? now : null,
        last_error: lastError,
        response_status: responseStatus,
        updated_at: now,
      })
      .where('id', '=', row.id)
      .where('status', '!=', 'sent')
      .execute();
    if (status !== 'sent') {
      options.log.warn('back-channel logout failed', {
        delivery_id: row.id,
        attempt: attempts,
        status,
      });
    }
  }

  return {
    attemptDue: async (): Promise<number> => {
      const now = nowOf();
      const rows = await options.ctx.db
        .selectFrom('logout_deliveries')
        .selectAll()
        .where('status', '=', 'retrying')
        .where('next_attempt_at', '<=', now)
        .orderBy('next_attempt_at')
        .limit(DUE_BATCH)
        .execute();
      for (const row of rows) await attempt(row);
      return rows.length;
    },
  };
}

export async function sweepLogoutDeliveries(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<number> {
  const cutoff = addMs(options.now, -options.retention);
  return deletedRows(
    await db
      .deleteFrom('logout_deliveries')
      .where('queued_at', '<', cutoff)
      .where('status', '!=', 'retrying')
      .execute(),
  );
}

export async function exportLogoutDeliveries(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('logout_deliveries')
    .innerJoin('clients', 'clients.id', 'logout_deliveries.client_id')
    .select([
      'logout_deliveries.id as id',
      'clients.client_id as client_id',
      'logout_deliveries.session_id as session_id',
      'logout_deliveries.cause as cause',
      'logout_deliveries.status as status',
      'logout_deliveries.attempts as attempts',
      'logout_deliveries.queued_at as queued_at',
      'logout_deliveries.sent_at as sent_at',
    ])
    .where('logout_deliveries.user_id', '=', userId)
    .orderBy('logout_deliveries.queued_at')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    client_id: row.client_id,
    session_id: row.session_id,
    cause: row.cause,
    status: row.status,
    attempts: row.attempts,
    queued_at: iso(row.queued_at),
    sent_at: iso(row.sent_at),
  }));
}
