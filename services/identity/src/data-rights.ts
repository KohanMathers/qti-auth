import { eraseUserObjects, heldObjectKey, type ObjectStore } from '@qtiauth/service-kit';
import { type Kysely, sql } from 'kysely';

import { dateOfBirthColumn } from './accounts.ts';
import { exportAuditRecords } from './audit.ts';
import type { Database } from './database.ts';
import { iso } from './iso.ts';
import { enqueueLedgerEntry, flushLedgerOutbox, type LedgerDestination } from './ledger.ts';
import { listStoredPreferences } from './notifications.ts';
import { listConsents } from './parental.ts';

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
      'deletion_requested_at',
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
    holds,
    exports,
    notifications,
    parental,
    parentalControls,
    childGuardians,
    guardianLinks,
    usernameChanges,
    familySessions,
    activityNotices,
    graduationNotice,
    removalRequests,
    restrictions,
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
    db
      .selectFrom('legal_holds')
      .select(['reason', 'case_id', 'placed_at', 'lifted_at'])
      .where('user_id', '=', userId)
      .orderBy('placed_at')
      .execute(),
    db
      .selectFrom('data_exports')
      .select(['status', 'bytes', 'created_at', 'completed_at', 'download_expires_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
    listStoredPreferences(db, userId),
    listConsents(db, userId),
    db
      .selectFrom('parental_controls')
      .select([
        'online_play',
        'in_game_chat',
        'user_generated_content',
        'purchases',
        'daily_playtime_minutes',
        'updated_at',
      ])
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('guardians')
      .select([
        'id',
        'email',
        'display_name',
        'status',
        'user_id',
        'created_at',
        'accepted_at',
        'revoked_at',
      ])
      .where('child_user_id', '=', userId)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('guardians')
      .select([
        'id',
        'child_user_id',
        'display_name',
        'status',
        'created_at',
        'accepted_at',
        'revoked_at',
      ])
      .where((eb) =>
        eb.or([eb('user_id', '=', userId), eb('email_normalized', '=', user.email_normalized)]),
      )
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('username_change_requests')
      .select(['id', 'username', 'status', 'requested_at', 'decided_at'])
      .where('user_id', '=', userId)
      .orderBy('requested_at')
      .execute(),
    db
      .selectFrom('family_sessions')
      .select(['id', 'created_at', 'last_active_at', 'expires_at', 'revoked_at'])
      .where('email_normalized', '=', user.email_normalized)
      .orderBy('created_at')
      .execute(),
    db
      .selectFrom('family_activity_notices')
      .select(['period_start', 'sent_at'])
      .where('child_user_id', '=', userId)
      .orderBy('period_start')
      .execute(),
    db
      .selectFrom('graduation_notices')
      .select(['notified_at', 'consent_age'])
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('guardian_removal_requests')
      .select(['id', 'status', 'requested_at', 'decided_at', 'last_reminded_at'])
      .where('user_id', '=', userId)
      .orderBy('requested_at')
      .execute(),
    db
      .selectFrom('user_restrictions')
      .select(['name', 'action_id', 'expires_at', 'created_at'])
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
      deletion_requested_at: iso(user.deletion_requested_at),
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
    legal_holds: holds.map((row) => ({
      reason: row.reason,
      case_id: row.case_id,
      placed_at: iso(row.placed_at),
      lifted_at: iso(row.lifted_at),
    })),
    data_exports: exports.map((row) => ({
      status: row.status,
      bytes: row.bytes,
      created_at: iso(row.created_at),
      completed_at: iso(row.completed_at),
      download_expires_at: iso(row.download_expires_at),
    })),
    notification_preferences: notifications.map((row) => ({
      category: row.category,
      enabled: row.enabled,
      updated_at: iso(row.updated_at),
    })),
    parental_consents: parental.map((row) => ({
      guardian_email: row.guardian_email,
      guardian_date_of_birth: row.guardian_date_of_birth,
      email_changes: row.email_changes,
      status: row.status,
      requested_at: iso(row.requested_at),
      decided_at: iso(row.decided_at),
    })),
    parental_controls:
      parentalControls === undefined
        ? null
        : {
            online_play: parentalControls.online_play,
            in_game_chat: parentalControls.in_game_chat,
            user_generated_content: parentalControls.user_generated_content,
            purchases: parentalControls.purchases,
            daily_playtime_minutes: parentalControls.daily_playtime_minutes,
            updated_at: iso(parentalControls.updated_at),
          },
    guardians: childGuardians.map((row) => ({
      id: row.id,
      email: row.email,
      display_name: row.display_name,
      status: row.status,
      linked: row.user_id !== null,
      created_at: iso(row.created_at),
      accepted_at: iso(row.accepted_at),
      revoked_at: iso(row.revoked_at),
    })),
    guardian_links: guardianLinks.map((row) => ({
      id: row.id,
      child_user_id: row.child_user_id,
      display_name: row.display_name,
      status: row.status,
      created_at: iso(row.created_at),
      accepted_at: iso(row.accepted_at),
      revoked_at: iso(row.revoked_at),
    })),
    username_change_requests: usernameChanges.map((row) => ({
      id: row.id,
      username: row.username,
      status: row.status,
      requested_at: iso(row.requested_at),
      decided_at: iso(row.decided_at),
    })),
    family_sessions: familySessions.map((row) => ({
      id: row.id,
      created_at: iso(row.created_at),
      last_active_at: iso(row.last_active_at),
      expires_at: iso(row.expires_at),
      revoked_at: iso(row.revoked_at),
    })),
    family_activity_notices: activityNotices.map((row) => ({
      period_start: iso(row.period_start),
      sent_at: iso(row.sent_at),
    })),
    graduation_notice:
      graduationNotice === undefined
        ? null
        : {
            notified_at: iso(graduationNotice.notified_at),
            consent_age: graduationNotice.consent_age,
          },
    guardian_removal_requests: removalRequests.map((row) => ({
      id: row.id,
      status: row.status,
      requested_at: iso(row.requested_at),
      decided_at: iso(row.decided_at),
      last_reminded_at: iso(row.last_reminded_at),
    })),
    restrictions: restrictions.map((row) => ({
      name: row.name,
      action_id: row.action_id,
      expires_at: iso(row.expires_at),
      created_at: iso(row.created_at),
    })),
  };
}

export async function eraseUser(
  db: Kysely<Database>,
  userId: string,
  options: {
    held: boolean;
    store: ObjectStore | null;
    ledger: LedgerDestination;
    onLedgerError?: (error: unknown) => void;
    now: Date;
  },
): Promise<void> {
  const snapshot =
    options.held && options.store !== null ? await exportUser(db, userId) : undefined;
  const user = await db
    .selectFrom('users')
    .select('email_normalized')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (user) {
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
  if (options.store !== null) {
    if (snapshot !== undefined) await putHeldSnapshot(options.store, userId, snapshot);
    await eraseUserObjects(options.store, userId, { preserveHeld: options.held });
  }
  await enqueueLedgerEntry(db, { userId, deletedAt: options.now });
  // A destination that is down leaves the entry queued for deletion_ledger.prune to retry.
  await flushLedgerOutbox(db, options.ledger, options.now, {
    ...(options.onLedgerError === undefined
      ? {}
      : { onWriteError: (error: unknown) => options.onLedgerError?.(error) }),
  });
}

export async function putHeldSnapshot(
  store: ObjectStore,
  userId: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  await store.put(
    heldObjectKey(userId, 'identity.json'),
    new TextEncoder().encode(`${JSON.stringify(snapshot, null, 2)}\n`),
    'application/json',
  );
}

export async function storeHeldSnapshot(
  db: Kysely<Database>,
  store: ObjectStore,
  userId: string,
): Promise<void> {
  await putHeldSnapshot(store, userId, await exportUser(db, userId));
}
