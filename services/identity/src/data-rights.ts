import type { Kysely } from 'kysely';

import { dateOfBirthColumn } from './accounts.ts';
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
      'created_at',
      'updated_at',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return {};

  const [identities, sessions, tokens, unusedRecovery] = await Promise.all([
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
  ]);

  return {
    account: {
      id: user.id,
      state: user.state,
      email: user.email,
      email_verified_at: iso(user.email_verified_at),
      date_of_birth: user.date_of_birth,
      locale: user.locale,
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
