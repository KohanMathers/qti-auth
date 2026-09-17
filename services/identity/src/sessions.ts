import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import { deletedRows } from '@qtiauth/db';
import { hashSessionToken, type ResolvedSession } from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import { dateOfBirthColumn } from './accounts.ts';
import { type AgeBands, ageBand, ageOn } from './age.ts';
import type { Database, RevocationReason } from './database.ts';
import { sessionCreatedEvent, sessionRevokedEvent } from './events.ts';
import { loadPermissions, twoFactorEnrolmentRequired } from './factors.ts';
import { newToken } from './tokens.ts';

export const MAX_USER_AGENT_LENGTH = 512;
export const LAST_ACTIVE_RESOLUTION = 60_000;
// Bound the eviction query; leftover extras go on the next sign-in.
const EVICTION_LIMIT = 1_000;

export interface SessionSettings {
  sessionTtl: number;
  idleTimeout: number;
  maxPerUser: number;
}

export interface SessionClient {
  userAgent: string | null;
  cookieScope: string;
}

export interface NewSession {
  userId: string;
  authMethod: string;
  amr: string[];
  acr: 'aal1' | 'aal2';
  client: SessionClient;
  settings: SessionSettings;
  now: Date;
}

export interface CreatedSession {
  id: string;
  token: string;
  expiresAt: Date;
  evicted: string[];
}

export interface SessionListItem {
  id: string;
  auth_method: string;
  user_agent: string | null;
  created_at: Date;
  last_active_at: Date;
  expires_at: Date;
}

function idleCutoff(now: Date, idleTimeout: number): Date {
  return new Date(now.getTime() - idleTimeout);
}

function activeSessions(db: Kysely<Database>, userId: string, now: Date, idleTimeout: number) {
  return db
    .selectFrom('sessions')
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .where('last_active_at', '>', idleCutoff(now, idleTimeout));
}

export function sessionExpiry(
  session: { expires_at: Date; last_active_at: Date },
  idleTimeout: number,
): Date {
  return new Date(
    Math.min(session.expires_at.getTime(), session.last_active_at.getTime() + idleTimeout),
  );
}

export async function revokeSessions(
  trx: Kysely<Database>,
  options: {
    userId: string;
    reason: RevocationReason;
    now: Date;
    only?: readonly string[];
    except?: string;
  },
): Promise<string[]> {
  const { userId, reason, now } = options;
  if (options.only?.length === 0) return [];
  let query = trx
    .updateTable('sessions')
    .set({ revoked_at: now, revoked_reason: reason })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now);
  if (options.only !== undefined) query = query.where('id', 'in', options.only);
  if (options.except !== undefined) query = query.where('id', '!=', options.except);
  const rows = await query.returning('id').execute();
  for (const row of rows) {
    await writeEvent(trx, sessionRevokedEvent({ session_id: row.id, user_id: userId, reason }));
  }
  return rows.map((row) => row.id);
}

export async function createSession(
  trx: Kysely<Database>,
  session: NewSession,
): Promise<CreatedSession> {
  const { settings, now } = session;
  const id = randomUUIDv7();
  const token = newToken();
  const expiresAt = new Date(now.getTime() + settings.sessionTtl);

  await trx
    .insertInto('sessions')
    .values({
      id,
      user_id: session.userId,
      auth_method: session.authMethod,
      amr: session.amr,
      acr: session.acr,
      step_up_at: session.acr === 'aal2' ? now : null,
      user_agent: session.client.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      created_at: now,
      last_active_at: now,
      expires_at: expiresAt,
    })
    .execute();
  await trx
    .insertInto('session_bindings')
    .values({
      id: randomUUIDv7(),
      session_id: id,
      token_hash: hashSessionToken(token),
      cookie_scope: session.client.cookieScope,
    })
    .execute();
  await writeEvent(
    trx,
    sessionCreatedEvent(id, {
      user_id: session.userId,
      auth_method: session.authMethod,
      amr: session.amr,
      acr: session.acr,
    }),
  );

  const overLimit = await activeSessions(trx, session.userId, now, settings.idleTimeout)
    .select('id')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .offset(settings.maxPerUser)
    .limit(EVICTION_LIMIT)
    .execute();
  const evicted = await revokeSessions(trx, {
    userId: session.userId,
    reason: 'evicted',
    now,
    only: overLimit.map((row) => row.id),
  });
  return { id, token, expiresAt, evicted };
}

export async function resolveSession(
  db: Kysely<Database>,
  options: {
    tokenHash: string;
    cookieScope: string;
    idleTimeout: number;
    bands: AgeBands;
    require2faFor: readonly string[];
    now: Date;
  },
): Promise<ResolvedSession | null> {
  const { now, idleTimeout } = options;
  const row = await db
    .selectFrom('session_bindings')
    .innerJoin('sessions', 'sessions.id', 'session_bindings.session_id')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'sessions.id',
      'sessions.user_id',
      'sessions.amr',
      'sessions.acr',
      'sessions.step_up_at',
      'sessions.expires_at',
      'sessions.last_active_at',
      'users.state',
      dateOfBirthColumn.as('date_of_birth'),
    ])
    .where('session_bindings.token_hash', '=', options.tokenHash)
    .where('session_bindings.cookie_scope', '=', options.cookieScope)
    .where('sessions.revoked_at', 'is', null)
    .where('sessions.expires_at', '>', now)
    .where('sessions.last_active_at', '>', idleCutoff(now, idleTimeout))
    .where('users.state', '!=', 'deleted')
    .executeTakeFirst();
  if (!row) return null;

  let lastActive = row.last_active_at;
  if (now.getTime() - lastActive.getTime() >= LAST_ACTIVE_RESOLUTION) {
    await db
      .updateTable('sessions')
      .set({ last_active_at: now })
      .where('id', '=', row.id)
      .where('last_active_at', '<', now)
      .execute();
    lastActive = now;
  }

  const permissions = await loadPermissions(db, row.user_id);
  return {
    session_id: row.id,
    user_id: row.user_id,
    account_state: row.state,
    permissions,
    restrictions: [],
    age_band: ageBand(ageOn(row.date_of_birth, now), options.bands),
    parental_controls: null,
    amr: row.amr,
    acr: row.acr,
    step_up_at: row.step_up_at?.toISOString() ?? null,
    legal_acceptance_required: false,
    two_factor_enrolment_required: await twoFactorEnrolmentRequired(db, {
      userId: row.user_id,
      permissions,
      patterns: options.require2faFor,
    }),
    expires_at: sessionExpiry(
      { expires_at: row.expires_at, last_active_at: lastActive },
      idleTimeout,
    ).toISOString(),
  };
}

export function listSessions(
  db: Kysely<Database>,
  options: {
    userId: string;
    idleTimeout: number;
    now: Date;
    after: { created_at: string; id: string } | undefined;
    limit: number;
  },
): Promise<SessionListItem[]> {
  let query = activeSessions(db, options.userId, options.now, options.idleTimeout)
    .select(['id', 'auth_method', 'user_agent', 'created_at', 'last_active_at', 'expires_at'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(options.limit);
  const { after } = options;
  if (after !== undefined) {
    const createdAt = new Date(after.created_at);
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', createdAt),
        eb.and([eb('created_at', '=', createdAt), eb('id', '<', after.id)]),
      ]),
    );
  }
  return query.execute();
}

export async function loadSession(
  db: Kysely<Database>,
  options: { sessionId: string; userId: string },
): Promise<
  { auth_method: string; created_at: Date; acr: string; step_up_at: Date | null } | undefined
> {
  return db
    .selectFrom('sessions')
    .select(['auth_method', 'created_at', 'acr', 'step_up_at'])
    .where('id', '=', options.sessionId)
    .where('user_id', '=', options.userId)
    .executeTakeFirst();
}

export async function upgradeSession(
  trx: Kysely<Database>,
  options: { sessionId: string; userId: string; amr: readonly string[]; now: Date },
): Promise<boolean> {
  const row = await trx
    .selectFrom('sessions')
    .select('amr')
    .where('id', '=', options.sessionId)
    .where('user_id', '=', options.userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row) return false;
  const amr = [...new Set([...row.amr, ...options.amr])];
  await trx
    .updateTable('sessions')
    .set({ amr, acr: 'aal2', step_up_at: options.now })
    .where('id', '=', options.sessionId)
    .execute();
  return true;
}

export async function countActiveSessions(
  db: Kysely<Database>,
  now: Date,
  idleTimeout: number,
): Promise<number> {
  const row = await db
    .selectFrom('sessions')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .where('last_active_at', '>', idleCutoff(now, idleTimeout))
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function sweepSessions(
  db: Kysely<Database>,
  options: { retention: number; idleTimeout: number; now: Date },
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.retention);
  const result = await db
    .deleteFrom('sessions')
    .where((eb) =>
      eb.or([
        eb('revoked_at', '<', cutoff),
        eb('expires_at', '<', cutoff),
        eb('last_active_at', '<', new Date(cutoff.getTime() - options.idleTimeout)),
      ]),
    )
    .execute();
  return deletedRows(result);
}
