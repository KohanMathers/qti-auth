import { randomUUIDv7 } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import { deletedRows } from '@qtiauth/db';
import { hashSessionToken, type ResolvedSession } from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import { expireLocks } from './account-locks.ts';
import { dateOfBirthColumn } from './accounts.ts';
import { type AgeBands, ageBand, ageOn } from './age.ts';
import type { Database, RevocationReason, SecurityEventKind } from './database.ts';
import { countryName, describePlace, deviceKey, parseDevice } from './device.ts';
import { sessionCreatedEvent, sessionFlaggedEvent, sessionRevokedEvent } from './events.ts';
import { twoFactorEnrolmentRequired } from './factors.ts';
import { loadParentalControls } from './family.ts';
import { iso } from './iso.ts';
import { legalAcceptanceRequired } from './legal.ts';
import { cancelPendingDeletion } from './pending-deletion.ts';
import { expireRestrictions, loadActiveRestrictions } from './restrictions.ts';
import { loadPermissions } from './roles.ts';
import {
  applyResolvedSecurity,
  baselineFromSession,
  currentSignals,
  evaluateSecurity,
  markAlertNotified,
  recentlyNotified,
  recordSecurityEvent,
  type RequestSignals,
  securityNeedsWrite,
  type SessionSecuritySettings,
  unchangedSecurity,
} from './security.ts';
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
  ip: string;
  tlsFingerprint: string | null;
  country: string | null;
  timezone: string | null;
  screen: string | null;
  clientFingerprint: string | null;
  restoreSessionId: string | null;
}

export interface NewDeviceNotice {
  email: string;
  locale: string | null;
  browser: string;
  os: string;
  place: string;
}

export interface NewSession {
  userId: string;
  authMethod: string;
  amr: string[];
  acr: 'aal1' | 'aal2';
  client: SessionClient;
  settings: SessionSettings;
  lookupCountry?: (ip: string) => string | null;
  now: Date;
}

export interface CreatedSession {
  id: string;
  /** null when an existing session was restored, so no new cookie is issued. */
  token: string | null;
  expiresAt: Date;
  evicted: string[];
  restored: boolean;
  newDevice: NewDeviceNotice | null;
  cancelledDeletion: boolean;
}

export interface SessionListItem {
  id: string;
  auth_method: string;
  user_agent: string | null;
  last_country: string | null;
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
  const restored = await restoreChallengedSession(trx, session);
  if (restored) return restored;

  const id = randomUUIDv7();
  const token = newToken();
  const expiresAt = new Date(now.getTime() + settings.sessionTtl);
  const captured = currentSignals(
    requestSignals(session.client),
    session.lookupCountry ?? (() => null),
  );
  const device = parseDevice(session.client.userAgent);
  const key = deviceKey(device);
  const userAgent = session.client.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null;

  await trx
    .insertInto('sessions')
    .values({
      id,
      user_id: session.userId,
      auth_method: session.authMethod,
      amr: session.amr,
      acr: session.acr,
      step_up_at: session.acr === 'aal2' ? now : null,
      user_agent: userAgent,
      ip: captured.ip,
      ip_subnet: captured.subnet,
      country: captured.country,
      last_country: captured.country,
      tls_fingerprint: captured.tlsFingerprint,
      timezone: captured.timezone,
      screen: captured.screen,
      client_fingerprint: captured.clientFingerprint,
      device_key: key,
      trust_level: 'full',
      created_at: now,
      last_active_at: now,
      expires_at: expiresAt,
    })
    .execute();
  await writeBinding(trx, {
    sessionId: id,
    tokenHash: hashSessionToken(token),
    cookieScope: session.client.cookieScope,
  });
  await writeEvent(
    trx,
    sessionCreatedEvent(id, {
      user_id: session.userId,
      auth_method: session.authMethod,
      amr: session.amr,
      acr: session.acr,
    }),
  );

  const seen = await trx
    .selectFrom('sessions')
    .select('id')
    .where('user_id', '=', session.userId)
    .where('device_key', '=', key)
    .where('id', '!=', id)
    .executeTakeFirst();
  let newDevice: NewDeviceNotice | null = null;
  if (seen === undefined) {
    const account = await trx
      .selectFrom('users')
      .select(['email', 'locale'])
      .where('id', '=', session.userId)
      .executeTakeFirst();
    if (account) {
      newDevice = {
        email: account.email,
        locale: account.locale,
        browser: device.browser,
        os: device.os,
        place: describePlace(captured.country),
      };
      await recordSecurityEvent(trx, {
        userId: session.userId,
        sessionId: id,
        kind: 'new_device',
        trustFrom: null,
        trustTo: 'full',
        countryFrom: null,
        countryTo: captured.country,
        notified: false,
        now,
      });
    }
  }

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
  const cancelledDeletion = await cancelPendingDeletion(trx, { userId: session.userId, now });
  return { id, token, expiresAt, evicted, restored: false, newDevice, cancelledDeletion };
}

function canRestore(session: NewSession): boolean {
  if (session.authMethod === 'magic_link' || session.authMethod === 'passkey') return true;
  return session.authMethod === 'password' && session.acr === 'aal2';
}

function requestSignals(client: SessionClient): RequestSignals {
  return {
    ip: client.ip,
    userAgent: client.userAgent,
    country: client.country,
    tlsFingerprint: client.tlsFingerprint,
    timezone: client.timezone,
    screen: client.screen,
    clientFingerprint: client.clientFingerprint,
  };
}

async function restoreChallengedSession(
  trx: Kysely<Database>,
  session: NewSession,
): Promise<CreatedSession | null> {
  const sessionId = session.client.restoreSessionId;
  if (sessionId === null || !canRestore(session)) return null;
  const row = await trx
    .selectFrom('sessions')
    .select(['id', 'acr', 'amr', 'expires_at', 'last_active_at', 'trust_level', 'country'])
    .where('id', '=', sessionId)
    .where('user_id', '=', session.userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', session.now)
    .executeTakeFirst();
  if (row?.acr !== 'aal0') return null;
  const captured = currentSignals(
    requestSignals(session.client),
    session.lookupCountry ?? (() => null),
  );
  const amr = [...new Set([...row.amr, ...session.amr])];
  await trx
    .updateTable('sessions')
    .set({
      amr,
      acr: session.acr,
      step_up_at: session.acr === 'aal2' ? session.now : null,
      trust_level: 'full',
      ip: captured.ip,
      ip_subnet: captured.subnet,
      country: captured.country,
      last_country: captured.country,
      tls_fingerprint: captured.tlsFingerprint,
      timezone: captured.timezone,
      screen: captured.screen,
      client_fingerprint: captured.clientFingerprint,
      user_agent: session.client.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      device_key: deviceKey(parseDevice(session.client.userAgent)),
      last_active_at: session.now,
    })
    .where('id', '=', row.id)
    .execute();
  await recordSecurityEvent(trx, {
    userId: session.userId,
    sessionId: row.id,
    kind: 'reauthenticated',
    trustFrom: row.trust_level,
    trustTo: 'full',
    countryFrom: row.country,
    countryTo: captured.country,
    notified: false,
    now: session.now,
  });
  return {
    id: row.id,
    token: null,
    expiresAt: sessionExpiry(row, session.settings.idleTimeout),
    evicted: [],
    restored: true,
    newDevice: null,
    cancelledDeletion: false,
  };
}

async function writeBinding(
  trx: Kysely<Database>,
  binding: { sessionId: string; tokenHash: string; cookieScope: string },
): Promise<void> {
  await trx
    .insertInto('session_bindings')
    .values({
      id: randomUUIDv7(),
      session_id: binding.sessionId,
      token_hash: binding.tokenHash,
      cookie_scope: binding.cookieScope,
    })
    .onConflict((conflict) =>
      conflict.columns(['session_id', 'cookie_scope']).doUpdateSet({
        token_hash: binding.tokenHash,
      }),
    )
    .execute();
}

export async function bindCookieScope(
  db: Kysely<Database>,
  options: { sessionId: string; cookieScope: string; idleTimeout: number; now: Date },
): Promise<{ token: string; expiresAt: Date } | null> {
  const row = await db
    .selectFrom('sessions')
    .select(['expires_at', 'last_active_at'])
    .where('id', '=', options.sessionId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', options.now)
    .where('last_active_at', '>', idleCutoff(options.now, options.idleTimeout))
    .executeTakeFirst();
  if (!row) return null;
  const token = newToken();
  await writeBinding(db, {
    sessionId: options.sessionId,
    tokenHash: hashSessionToken(token),
    cookieScope: options.cookieScope,
  });
  return { token, expiresAt: sessionExpiry(row, options.idleTimeout) };
}

export interface SecurityAlert {
  email: string;
  locale: string | null;
  summary: string;
  place: string;
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
    signals?: RequestSignals;
    security?: SessionSecuritySettings;
    lookupCountry?: (ip: string) => string | null;
  },
): Promise<{
  session: ResolvedSession | null;
  alert: SecurityAlert | null;
  unlocked: boolean;
  restrictionsChanged: boolean;
} | null> {
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
      'sessions.ip',
      'sessions.ip_subnet',
      'sessions.country',
      'sessions.user_agent',
      'sessions.tls_fingerprint',
      'sessions.timezone',
      'sessions.screen',
      'sessions.client_fingerprint',
      'sessions.trust_level',
      'sessions.last_country',
      'users.state',
      'users.locked_until',
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

  let accountState = row.state;
  let unlocked = false;
  if (row.state === 'locked') {
    unlocked = (await expireLocks(db, now, row.user_id)).length > 0;
    if (unlocked) accountState = 'active';
  }
  const restrictionsChanged = (await expireRestrictions(db, now, row.user_id)).length > 0;
  const restrictions = await loadActiveRestrictions(db, row.user_id, now);

  let acr = row.acr;
  let lastActive = row.last_active_at;
  let alert: SecurityAlert | null = null;
  const security = options.security;
  if (security !== undefined && security.enabled && options.signals !== undefined) {
    const current = currentSignals(options.signals, options.lookupCountry ?? (() => null));
    const baseline = baselineFromSession(row);
    const state = { acr: row.acr, trustLevel: row.trust_level, lastCountry: row.last_country };
    const outcome = evaluateSecurity(baseline, current, row.acr, security.onCountryChange);
    const applied = securityNeedsWrite(outcome, state, current.country)
      ? await db.transaction().execute(async (trx) => {
          const result = await applyResolvedSecurity(trx, {
            sessionId: row.id,
            userId: row.user_id,
            ...state,
            baseline,
            current,
            outcome,
            now,
          });
          if (result.blocked) {
            await revokeSessions(trx, {
              userId: row.user_id,
              reason: 'blocked',
              now,
              only: [row.id],
            });
          }
          return result;
        })
      : unchangedSecurity(outcome, baseline, current);
    if (applied.notify) {
      alert = await securityAlert(db, {
        userId: row.user_id,
        sessionId: row.id,
        kind: outcome.countryChanged ? 'country_change' : 'trust_transition',
        trustTo: applied.trustLevel,
        countryFrom: applied.countryFrom,
        countryTo: applied.countryTo,
        blocked: applied.blocked,
        interval: security.alertMinInterval,
        now,
      });
    }
    if (applied.blocked) return { session: null, alert, unlocked, restrictionsChanged };
    acr = applied.acr;
  }

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
    session: {
      session_id: row.id,
      user_id: row.user_id,
      account_state: accountState,
      permissions,
      restrictions,
      age_band: ageBand(ageOn(row.date_of_birth, now), options.bands),
      parental_controls: await loadParentalControls(db, row.user_id),
      amr: row.amr,
      acr,
      step_up_at: acr === 'aal0' ? null : iso(row.step_up_at),
      legal_acceptance_required: await legalAcceptanceRequired(db, row.user_id, now),
      two_factor_enrolment_required: await twoFactorEnrolmentRequired(db, {
        userId: row.user_id,
        permissions,
        patterns: options.require2faFor,
      }),
      expires_at: sessionExpiry(
        { expires_at: row.expires_at, last_active_at: lastActive },
        idleTimeout,
      ).toISOString(),
    },
    alert,
    unlocked,
    restrictionsChanged,
  };
}

async function securityAlert(
  db: Kysely<Database>,
  options: {
    userId: string;
    sessionId: string;
    kind: SecurityEventKind;
    trustTo: string | null;
    countryFrom: string | null;
    countryTo: string | null;
    blocked: boolean;
    interval: number;
    now: Date;
  },
): Promise<SecurityAlert | null> {
  const since = new Date(options.now.getTime() - options.interval);
  if (await recentlyNotified(db, options.userId, since)) return null;
  const account = await db
    .selectFrom('users')
    .select(['email', 'locale'])
    .where('id', '=', options.userId)
    .executeTakeFirst();
  if (!account) return null;
  const from = countryName(options.countryFrom) ?? 'an unknown location';
  const to = countryName(options.countryTo) ?? 'an unknown location';
  const summary = options.blocked
    ? `A session was ended after a sign-in from ${to}`
    : `A session moved from ${from} to ${to}`;
  await markAlertNotified(db, {
    userId: options.userId,
    sessionId: options.sessionId,
    kind: options.kind,
    trustTo: options.trustTo,
    countryFrom: options.countryFrom,
    countryTo: options.countryTo,
    since,
    now: options.now,
  });
  return {
    email: account.email,
    locale: account.locale,
    summary,
    place: describePlace(options.countryTo),
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
    .select([
      'id',
      'auth_method',
      'user_agent',
      'last_country',
      'created_at',
      'last_active_at',
      'expires_at',
    ])
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

export async function challengeSessions(
  trx: Kysely<Database>,
  options: { userId: string; now: Date },
): Promise<string[]> {
  const rows = await trx
    .selectFrom('sessions')
    .select(['id', 'trust_level', 'acr', 'country'])
    .where('user_id', '=', options.userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', options.now)
    .execute();
  const challenged: string[] = [];
  for (const row of rows) {
    if (row.acr === 'aal0') continue;
    await trx
      .updateTable('sessions')
      .set({ acr: 'aal0', trust_level: 'challenge', step_up_at: null })
      .where('id', '=', row.id)
      .execute();
    await recordSecurityEvent(trx, {
      userId: options.userId,
      sessionId: row.id,
      kind: 'force_reauth',
      trustFrom: row.trust_level,
      trustTo: 'challenge',
      countryFrom: row.country,
      countryTo: row.country,
      notified: false,
      now: options.now,
    });
    await writeEvent(
      trx,
      sessionFlaggedEvent({
        session_id: row.id,
        user_id: options.userId,
        reason: 'staff',
        trust_level: 'challenge',
        acr: 'aal0',
      }),
    );
    challenged.push(row.id);
  }
  return challenged;
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
