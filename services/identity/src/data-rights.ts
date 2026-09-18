import { type Kysely, sql } from 'kysely';

import { dateOfBirthColumn } from './accounts.ts';
import { exportAuditRecords } from './audit.ts';
import type { Database } from './database.ts';

function iso(date: Date | null): string | null {
  return date?.toISOString() ?? null;
}

export async function exportUser(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>> {
  const user = await db
    .selectFrom('users')
    .select([
      'id',
      'state',
      'email',
      'email_normalized',
      'email_verified_at',
      dateOfBirthColumn.as('date_of_birth'),
      'locale',
      'username',
      'username_updated_at',
      'public_profile',
      'leaderboard_visible',
      'security_notifications',
      'locked_until',
      'username_reset_required',
      'created_at',
      'updated_at',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return {};

  const [
    identities,
    sessions,
    tokens,
    unusedRecovery,
    securityEvents,
    usernameHistory,
    ageAssurance,
    dateOfBirthChanges,
    roles,
    audit,
    legal,
    staffActions,
  ] = await Promise.all([
    db
      .selectFrom('identities')
      .select(['type', 'subject', 'created_at', 'last_used_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('sessions')
      .select([
        'id',
        'auth_method',
        'acr',
        'user_agent',
        'ip',
        'country',
        'last_country',
        'trust_level',
        'created_at',
        'last_active_at',
        'expires_at',
        'revoked_at',
        'revoked_reason',
      ])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('email_tokens')
      .select(['purpose', 'email', 'locale', 'created_at', 'expires_at', 'used_at'])
      .where('email_normalized', '=', user.email_normalized)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('recovery_codes')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .executeTakeFirst(),
    db
      .selectFrom('session_security_events')
      .select([
        'kind',
        'trust_from',
        'trust_to',
        'country_from',
        'country_to',
        'notified',
        'created_at',
      ])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('username_history')
      .select(['username', 'claimed_at', 'released_at'])
      .where('user_id', '=', userId)
      .orderBy('claimed_at')
      .execute(),
    db
      .selectFrom('age_assurance_results')
      .select(['provider', 'strength', 'trigger', 'vendor_reference', 'created_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('date_of_birth_changes')
      .select([
        'reason',
        sql<string>`to_char(previous_date_of_birth, 'YYYY-MM-DD')`.as('previous_date_of_birth'),
        sql<string>`to_char(date_of_birth, 'YYYY-MM-DD')`.as('date_of_birth'),
        'created_at',
      ])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('user_roles')
      .innerJoin('roles', 'roles.id', 'user_roles.role_id')
      .select(['roles.slug as slug', 'roles.name as name'])
      .where('user_roles.user_id', '=', userId)
      .orderBy('roles.slug')
      .execute(),
    exportAuditRecords(db, userId),
    db
      .selectFrom('legal_acceptances')
      .select(['document_id', 'version', 'accepted_at', 'ip', 'method'])
      .where('user_id', '=', userId)
      .orderBy('accepted_at')
      .execute(),
    db
      .selectFrom('account_actions')
      .select([
        'action',
        'reason',
        'from_state',
        'to_state',
        'expires_at',
        'actor_type',
        'actor_id',
        'created_at',
      ])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
  ]);

  return {
    account: {
      id: user.id,
      state: user.state,
      email: user.email,
      email_verified_at: iso(user.email_verified_at),
      date_of_birth: user.date_of_birth,
      locale: user.locale,
      username: user.username,
      username_updated_at: iso(user.username_updated_at),
      locked_until: iso(user.locked_until),
      username_reset_required: user.username_reset_required,
      public_profile: user.public_profile,
      leaderboard_visible: user.leaderboard_visible,
      security_notifications: user.security_notifications,
      created_at: iso(user.created_at),
      updated_at: iso(user.updated_at),
    },
    sign_in_methods: identities.map((identity) => ({
      type: identity.type,
      subject: identity.subject,
      created_at: iso(identity.created_at),
      last_used_at: iso(identity.last_used_at),
    })),
    sessions: sessions.map((session) => ({
      ...session,
      created_at: iso(session.created_at),
      last_active_at: iso(session.last_active_at),
      expires_at: iso(session.expires_at),
      revoked_at: iso(session.revoked_at),
    })),
    email_tokens: tokens.map((token) => ({
      ...token,
      created_at: iso(token.created_at),
      expires_at: iso(token.expires_at),
      used_at: iso(token.used_at),
    })),
    recovery_codes: { unused: Number(unusedRecovery?.count ?? 0) },
    session_security_events: securityEvents.map((event) => ({
      ...event,
      created_at: iso(event.created_at),
    })),
    username_history: usernameHistory.map((row) => ({
      username: row.username,
      claimed_at: iso(row.claimed_at),
      released_at: iso(row.released_at),
    })),
    age_assurance: ageAssurance.map((row) => ({
      provider: row.provider,
      strength: row.strength,
      trigger: row.trigger,
      vendor_reference: row.vendor_reference,
      created_at: iso(row.created_at),
    })),
    date_of_birth_changes: dateOfBirthChanges.map((row) => ({
      reason: row.reason,
      previous_date_of_birth: row.previous_date_of_birth,
      date_of_birth: row.date_of_birth,
      created_at: iso(row.created_at),
    })),
    roles: roles.map((row) => ({ slug: row.slug, name: row.name })),
    audit: audit.map((row) => ({
      occurred_at: iso(row.occurred_at),
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      action: row.action,
      target_type: row.target_type,
      target_id: row.target_id,
    })),
    legal_acceptances: legal.map((row) => ({
      document_id: row.document_id,
      version: row.version,
      accepted_at: iso(row.accepted_at),
      ip: row.ip,
      method: row.method,
    })),
    staff_actions: staffActions.map((row) => ({
      action: row.action,
      reason: row.reason,
      from_state: row.from_state,
      to_state: row.to_state,
      expires_at: iso(row.expires_at),
      actor_type: row.actor_type,
      actor_id: row.actor_id,
      created_at: iso(row.created_at),
    })),
  };
}

export async function eraseUser(db: Kysely<Database>, userId: string): Promise<void> {
  const user = await db
    .selectFrom('users')
    .select('email_normalized')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return;
  const others = await db
    .selectFrom('users')
    .select('id')
    .where('email_normalized', '=', user.email_normalized)
    .where('id', '!=', userId)
    .where('state', '!=', 'deleted')
    .executeTakeFirst();
  if (!others) {
    await db
      .deleteFrom('email_tokens')
      .where('email_normalized', '=', user.email_normalized)
      .execute();
    await db
      .deleteFrom('auth_failures')
      .where('kind', '=', 'account')
      .where('key', '=', user.email_normalized)
      .execute();
  }
  await db.deleteFrom('users').where('id', '=', userId).execute();
}
