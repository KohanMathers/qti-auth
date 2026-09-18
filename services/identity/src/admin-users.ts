import { type Bus, rpcRequest, writeEvent } from '@qtiauth/bus';
import { updatedRows } from '@qtiauth/db';
import type { EventActor } from '@qtiauth/events';
import { type AccountState, type AgeBand } from '@qtiauth/service-kit';
import { type Kysely, sql } from 'kysely';

import { expireLocks, recordAccountAction } from './account-locks.ts';
import { type Account, canTransition, dateOfBirthColumn, findAccount } from './accounts.ts';
import { type AgeBands, ageBand, ageOn, dateOfBirthBounds } from './age.ts';
import type { AccountAction, Database } from './database.ts';
import { parseDevice } from './device.ts';
import {
  type UserBannedData,
  type UserLockedData,
  type UserUnbannedData,
  type UserUnlockedData,
  type UserUpdatedData,
  userBannedEvent,
  userLockedEvent,
  userUnbannedEvent,
  userUnlockedEvent,
  userUpdatedEvent,
} from './events.ts';
import { iso } from './iso.ts';
import { loadUserRoles } from './roles.ts';
import { challengeSessions, listSessions, revokeSessions, sessionExpiry } from './sessions.ts';
import { releaseCurrentUsername } from './usernames.ts';

export const ACTION_REASON_MAX = 1000;
export const USER_DETAIL_LIMIT = 50;

export const USER_MODERATION_SERVICE = 'safety';
export const USER_MODERATION_METHOD = 'user_moderation';
export const USER_ENTITLEMENTS_SERVICE = 'games';
export const USER_ENTITLEMENTS_METHOD = 'user_entitlements';
export const USER_TICKETS_SERVICE = 'support';
export const USER_TICKETS_METHOD = 'user_tickets';

export type AdminUserError = 'not_found' | 'self' | 'conflict' | 'lock_expiry';

export interface SearchUsersOptions {
  q?: string;
  state?: AccountState;
  ageBand?: AgeBand;
  roleId?: string;
  createdFrom?: Date;
  createdTo?: Date;
  after?: { created_at: string; id: string };
  limit: number;
  bands: AgeBands;
  now: Date;
}

export interface UserSearchItem {
  id: string;
  email: string;
  username: string | null;
  state: AccountState;
  age_band: AgeBand;
  created_at: Date;
  roles: { id: string; slug: string; name: string }[];
}

export interface UserDetail {
  profile: {
    id: string;
    email: string;
    email_verified_at: string | null;
    username: string | null;
    username_updated_at: string | null;
    username_reset_required: boolean;
    state: AccountState;
    age_band: AgeBand;
    date_of_birth: string;
    locale: string | null;
    public_profile: boolean;
    leaderboard_visible: boolean;
    locked_until: string | null;
    created_at: string;
    roles: { id: string; slug: string; name: string }[];
  };
  sign_in_methods: {
    id: string;
    type: string;
    subject: string | null;
    created_at: string;
    last_used_at: string | null;
  }[];
  sessions: {
    id: string;
    auth_method: string;
    user_agent: string | null;
    device: { browser: string; os: string };
    country: string | null;
    created_at: string;
    last_active_at: string;
    expires_at: string;
  }[];
  security_events: {
    id: string;
    kind: string;
    trust_from: string | null;
    trust_to: string | null;
    country_from: string | null;
    country_to: string | null;
    created_at: string;
  }[];
  username_history: {
    username: string;
    claimed_at: string;
    released_at: string | null;
  }[];
  staff_actions: {
    id: string;
    actor_type: string;
    actor_id: string;
    action: AccountAction;
    reason: string;
    from_state: AccountState | null;
    to_state: AccountState | null;
    expires_at: string | null;
    created_at: string;
  }[];
  guardians: [];
  moderation?: unknown;
  entitlements?: unknown;
  tickets?: unknown;
}

async function staffTarget(
  db: Kysely<Database>,
  options: { userId: string; actorId: string; now: Date },
): Promise<{ status: 'not_found' } | { status: 'self' } | { status: 'ok'; account: Account }> {
  if (options.userId === options.actorId) return { status: 'self' };
  await expireLocks(db, options.now, options.userId);
  const account = await findAccount(db, options.userId);
  if (!account || account.state === 'deleted') return { status: 'not_found' };
  return { status: 'ok', account };
}

export async function searchUsers(
  db: Kysely<Database>,
  options: SearchUsersOptions,
): Promise<UserSearchItem[]> {
  const { after } = options;
  let query = db
    .selectFrom('users')
    .select([
      'id',
      'email',
      'username',
      'state',
      dateOfBirthColumn.as('date_of_birth'),
      'created_at',
    ]);
  query = query.where('state', '!=', 'deleted');
  if (options.state !== undefined) {
    query = query.where('state', '=', options.state);
  }
  const q = options.q?.trim();
  if (q !== undefined && q !== '') {
    query = query.where(sql<boolean>`search_vector @@ websearch_to_tsquery('simple', ${q})`);
  }
  if (options.ageBand !== undefined) {
    const bounds = dateOfBirthBounds(options.ageBand, options.now, options.bands);
    query = query.where(
      sql<boolean>`users.date_of_birth > ${bounds.after}::date and users.date_of_birth <= ${bounds.through}::date`,
    );
  }
  if (options.roleId !== undefined) {
    const roleId = options.roleId;
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom('user_roles')
          .select('user_id')
          .whereRef('user_roles.user_id', '=', 'users.id')
          .where('user_roles.role_id', '=', roleId),
      ),
    );
  }
  if (options.createdFrom !== undefined) {
    query = query.where('created_at', '>=', options.createdFrom);
  }
  if (options.createdTo !== undefined) {
    query = query.where('created_at', '<=', options.createdTo);
  }
  if (after !== undefined) {
    const createdAt = new Date(after.created_at);
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', createdAt),
        eb.and([eb('created_at', '=', createdAt), eb('id', '<', after.id)]),
      ]),
    );
  }
  const rows = await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(options.limit)
    .execute();
  const roles = await rolesForUsers(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    username: row.username,
    state: row.state,
    age_band: ageBand(ageOn(row.date_of_birth, options.now), options.bands),
    created_at: row.created_at,
    roles: roles.get(row.id) ?? [],
  }));
}

async function rolesForUsers(
  db: Kysely<Database>,
  userIds: string[],
): Promise<Map<string, { id: string; slug: string; name: string }[]>> {
  const grouped = new Map<string, { id: string; slug: string; name: string }[]>();
  if (userIds.length === 0) return grouped;
  const rows = await db
    .selectFrom('user_roles')
    .innerJoin('roles', 'roles.id', 'user_roles.role_id')
    .select([
      'user_roles.user_id as user_id',
      'roles.id as id',
      'roles.slug as slug',
      'roles.name as name',
    ])
    .where('user_roles.user_id', 'in', userIds)
    .orderBy('roles.slug')
    .execute();
  for (const row of rows) {
    const list = grouped.get(row.user_id) ?? [];
    list.push({ id: row.id, slug: row.slug, name: row.name });
    grouped.set(row.user_id, list);
  }
  return grouped;
}

async function optionalSection(
  bus: Bus,
  service: string,
  method: string,
  userId: string,
): Promise<unknown> {
  const result = await rpcRequest<unknown>(bus, service, method, { user_id: userId });
  if (result.status === 'ok') return result.data;
  return undefined;
}

export async function getUserDetail(
  db: Kysely<Database>,
  options: {
    userId: string;
    bus: Bus;
    bands: AgeBands;
    idleTimeout: number;
    now: Date;
  },
): Promise<UserDetail | undefined> {
  await expireLocks(db, options.now, options.userId);
  const account = await findAccount(db, options.userId);
  if (!account || account.state === 'deleted') return undefined;

  const [
    roles,
    identities,
    sessions,
    securityEvents,
    usernameHistory,
    staffActions,
    moderation,
    entitlements,
    tickets,
  ] = await Promise.all([
    loadUserRoles(db, options.userId),
    db
      .selectFrom('identities')
      .select(['id', 'type', 'subject', 'created_at', 'last_used_at'])
      .where('user_id', '=', options.userId)
      .orderBy('created_at')
      .execute(),
    listSessions(db, {
      userId: options.userId,
      idleTimeout: options.idleTimeout,
      now: options.now,
      after: undefined,
      limit: USER_DETAIL_LIMIT,
    }),
    db
      .selectFrom('session_security_events')
      .select(['id', 'kind', 'trust_from', 'trust_to', 'country_from', 'country_to', 'created_at'])
      .where('user_id', '=', options.userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(USER_DETAIL_LIMIT)
      .execute(),
    db
      .selectFrom('username_history')
      .select(['username', 'claimed_at', 'released_at'])
      .where('user_id', '=', options.userId)
      .orderBy('claimed_at', 'desc')
      .limit(USER_DETAIL_LIMIT)
      .execute(),
    db
      .selectFrom('account_actions')
      .selectAll()
      .where('user_id', '=', options.userId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(USER_DETAIL_LIMIT)
      .execute(),
    optionalSection(options.bus, USER_MODERATION_SERVICE, USER_MODERATION_METHOD, options.userId),
    optionalSection(
      options.bus,
      USER_ENTITLEMENTS_SERVICE,
      USER_ENTITLEMENTS_METHOD,
      options.userId,
    ),
    optionalSection(options.bus, USER_TICKETS_SERVICE, USER_TICKETS_METHOD, options.userId),
  ]);

  const detail: UserDetail = {
    profile: {
      id: account.id,
      email: account.email,
      email_verified_at: iso(account.email_verified_at),
      username: account.username,
      username_updated_at: iso(account.username_updated_at),
      username_reset_required: account.username_reset_required,
      state: account.state,
      age_band: ageBand(ageOn(account.date_of_birth, options.now), options.bands),
      date_of_birth: account.date_of_birth,
      locale: account.locale,
      public_profile: account.public_profile,
      leaderboard_visible: account.leaderboard_visible,
      locked_until: iso(account.locked_until),
      created_at: account.created_at.toISOString(),
      roles: roles.map((role) => ({ id: role.id, slug: role.slug, name: role.name })),
    },
    sign_in_methods: identities.map((identity) => ({
      id: identity.id,
      type: identity.type,
      subject: identity.subject,
      created_at: identity.created_at.toISOString(),
      last_used_at: iso(identity.last_used_at),
    })),
    sessions: sessions.map((session) => ({
      id: session.id,
      auth_method: session.auth_method,
      user_agent: session.user_agent,
      device: parseDevice(session.user_agent),
      country: session.last_country,
      created_at: session.created_at.toISOString(),
      last_active_at: session.last_active_at.toISOString(),
      expires_at: sessionExpiry(session, options.idleTimeout).toISOString(),
    })),
    security_events: securityEvents.map((event) => ({
      id: event.id,
      kind: event.kind,
      trust_from: event.trust_from,
      trust_to: event.trust_to,
      country_from: event.country_from,
      country_to: event.country_to,
      created_at: event.created_at.toISOString(),
    })),
    username_history: usernameHistory.map((row) => ({
      username: row.username,
      claimed_at: row.claimed_at.toISOString(),
      released_at: iso(row.released_at),
    })),
    staff_actions: staffActions.map((row) => ({
      id: row.id,
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      action: row.action,
      reason: row.reason,
      from_state: row.from_state,
      to_state: row.to_state,
      expires_at: iso(row.expires_at),
      created_at: row.created_at.toISOString(),
    })),
    guardians: [],
  };
  if (moderation !== undefined) detail.moderation = moderation;
  if (entitlements !== undefined) detail.entitlements = entitlements;
  if (tickets !== undefined) detail.tickets = tickets;
  return detail;
}

type StateChangeResult = { status: 'ok' } | { status: AdminUserError };

export async function banUser(
  db: Kysely<Database>,
  options: { userId: string; actorId: string; reason: string; now: Date },
): Promise<StateChangeResult> {
  const target = await staffTarget(db, options);
  if (target.status !== 'ok') return target;
  const { account } = target;
  if (!canTransition(account.state, 'banned')) return { status: 'conflict' };
  const actor: EventActor = { type: 'user', id: options.actorId };
  return db.transaction().execute(async (trx): Promise<StateChangeResult> => {
    const updated = await trx
      .updateTable('users')
      .set({ state: 'banned', locked_until: null, updated_at: options.now })
      .where('id', '=', options.userId)
      .where('state', '=', account.state)
      .executeTakeFirst();
    if (updatedRows(updated) === 0) return { status: 'conflict' };
    await recordAccountAction(trx, {
      userId: options.userId,
      actor,
      action: 'ban',
      reason: options.reason,
      fromState: account.state,
      toState: 'banned',
      expiresAt: null,
      now: options.now,
    });
    await writeEvent<Database, UserBannedData>(
      trx,
      userBannedEvent(account.id, { reason: options.reason }, actor),
    );
    return { status: 'ok' };
  });
}

export async function unbanUser(
  db: Kysely<Database>,
  options: { userId: string; actorId: string; reason: string; now: Date },
): Promise<StateChangeResult> {
  const target = await staffTarget(db, options);
  if (target.status !== 'ok') return target;
  const { account } = target;
  if (account.state !== 'banned' || !canTransition(account.state, 'active')) {
    return { status: 'conflict' };
  }
  const actor: EventActor = { type: 'user', id: options.actorId };
  return db.transaction().execute(async (trx): Promise<StateChangeResult> => {
    const updated = await trx
      .updateTable('users')
      .set({ state: 'active', updated_at: options.now })
      .where('id', '=', options.userId)
      .where('state', '=', 'banned')
      .executeTakeFirst();
    if (updatedRows(updated) === 0) return { status: 'conflict' };
    await recordAccountAction(trx, {
      userId: options.userId,
      actor,
      action: 'unban',
      reason: options.reason,
      fromState: 'banned',
      toState: 'active',
      expiresAt: null,
      now: options.now,
    });
    await writeEvent<Database, UserUnbannedData>(
      trx,
      userUnbannedEvent(account.id, { reason: options.reason }, actor),
    );
    return { status: 'ok' };
  });
}

export async function lockUser(
  db: Kysely<Database>,
  options: { userId: string; actorId: string; reason: string; expiresAt: Date; now: Date },
): Promise<StateChangeResult> {
  if (options.expiresAt.getTime() <= options.now.getTime()) return { status: 'lock_expiry' };
  const target = await staffTarget(db, options);
  if (target.status !== 'ok') return target;
  const { account } = target;
  if (account.state !== 'locked' && !canTransition(account.state, 'locked')) {
    return { status: 'conflict' };
  }
  const actor: EventActor = { type: 'user', id: options.actorId };
  return db.transaction().execute(async (trx): Promise<StateChangeResult> => {
    const updated = await trx
      .updateTable('users')
      .set({ state: 'locked', locked_until: options.expiresAt, updated_at: options.now })
      .where('id', '=', options.userId)
      .where('state', '=', account.state)
      .executeTakeFirst();
    if (updatedRows(updated) === 0) return { status: 'conflict' };
    await recordAccountAction(trx, {
      userId: options.userId,
      actor,
      action: 'lock',
      reason: options.reason,
      fromState: account.state,
      toState: 'locked',
      expiresAt: options.expiresAt,
      now: options.now,
    });
    await writeEvent<Database, UserLockedData>(
      trx,
      userLockedEvent(
        account.id,
        { reason: options.reason, expires_at: options.expiresAt.toISOString() },
        actor,
      ),
    );
    return { status: 'ok' };
  });
}

export async function unlockUser(
  db: Kysely<Database>,
  options: { userId: string; actorId: string; reason: string; now: Date },
): Promise<StateChangeResult> {
  const target = await staffTarget(db, options);
  if (target.status !== 'ok') return target;
  const { account } = target;
  if (account.state !== 'locked') return { status: 'conflict' };
  const actor: EventActor = { type: 'user', id: options.actorId };
  return db.transaction().execute(async (trx): Promise<StateChangeResult> => {
    const updated = await trx
      .updateTable('users')
      .set({ state: 'active', locked_until: null, updated_at: options.now })
      .where('id', '=', options.userId)
      .where('state', '=', 'locked')
      .executeTakeFirst();
    if (updatedRows(updated) === 0) return { status: 'conflict' };
    await recordAccountAction(trx, {
      userId: options.userId,
      actor,
      action: 'unlock',
      reason: options.reason,
      fromState: 'locked',
      toState: 'active',
      expiresAt: null,
      now: options.now,
    });
    await writeEvent<Database, UserUnlockedData>(
      trx,
      userUnlockedEvent(account.id, { reason: options.reason }, actor),
    );
    return { status: 'ok' };
  });
}

export async function forceReauth(
  db: Kysely<Database>,
  options: { userId: string; actorId: string; reason: string; now: Date },
): Promise<{ status: 'ok'; challenged: number } | { status: AdminUserError }> {
  const target = await staffTarget(db, options);
  if (target.status !== 'ok') return target;
  const actor: EventActor = { type: 'user', id: options.actorId };
  const challenged = await db.transaction().execute(async (trx) => {
    const ids = await challengeSessions(trx, { userId: options.userId, now: options.now });
    await recordAccountAction(trx, {
      userId: options.userId,
      actor,
      action: 'force_reauth',
      reason: options.reason,
      fromState: target.account.state,
      toState: target.account.state,
      expiresAt: null,
      now: options.now,
    });
    return ids.length;
  });
  return { status: 'ok', challenged };
}

export async function revokeUserSessions(
  db: Kysely<Database>,
  options: { userId: string; actorId: string; reason: string; now: Date },
): Promise<{ status: 'ok'; revoked: string[] } | { status: AdminUserError }> {
  const target = await staffTarget(db, options);
  if (target.status !== 'ok') return target;
  const actor: EventActor = { type: 'user', id: options.actorId };
  const revoked = await db.transaction().execute(async (trx) => {
    const ids = await revokeSessions(trx, {
      userId: options.userId,
      reason: 'revoked',
      now: options.now,
    });
    await recordAccountAction(trx, {
      userId: options.userId,
      actor,
      action: 'revoke_sessions',
      reason: options.reason,
      fromState: target.account.state,
      toState: target.account.state,
      expiresAt: null,
      now: options.now,
    });
    return ids;
  });
  return { status: 'ok', revoked };
}

export async function forceUsernameReset(
  db: Kysely<Database>,
  options: { userId: string; actorId: string; reason: string; now: Date },
): Promise<StateChangeResult> {
  const target = await staffTarget(db, options);
  if (target.status !== 'ok') return target;
  const actor: EventActor = { type: 'user', id: options.actorId };
  await db.transaction().execute(async (trx) => {
    const released = await releaseCurrentUsername(trx, {
      userId: options.userId,
      now: options.now,
    });
    if (!released) {
      await trx
        .updateTable('users')
        .set({ username_reset_required: true, updated_at: options.now })
        .where('id', '=', options.userId)
        .execute();
    }
    await recordAccountAction(trx, {
      userId: options.userId,
      actor,
      action: 'force_username_reset',
      reason: options.reason,
      fromState: target.account.state,
      toState: target.account.state,
      expiresAt: null,
      now: options.now,
    });
    await writeEvent<Database, UserUpdatedData>(
      trx,
      userUpdatedEvent(options.userId, { fields: ['username'] }, actor),
    );
  });
  return { status: 'ok' };
}
