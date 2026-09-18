import { randomUUIDv7 } from 'node:crypto';

import type { AccountState } from '@qtiauth/service-kit';
import { type Kysely, sql } from 'kysely';

import type { Database } from './database.ts';

export const ACCOUNT_TRANSITIONS: Readonly<Record<AccountState, readonly AccountState[]>> = {
  pending_email_verification: ['active', 'pending_parental_consent', 'deleted'],
  pending_parental_consent: ['active', 'deleted'],
  active: ['locked', 'banned', 'pending_deletion'],
  locked: ['active', 'banned', 'pending_deletion'],
  banned: ['active', 'pending_deletion'],
  pending_deletion: ['active', 'deleted'],
  deleted: [],
};

export const SIGNED_IN_STATES = Object.keys(ACCOUNT_TRANSITIONS).filter(
  (state) => state !== 'deleted',
) as Exclude<AccountState, 'deleted'>[];

export class AccountStateError extends Error {
  constructor(from: AccountState, to: AccountState) {
    super(`An account can't go from ${from} to ${to}`);
    this.name = 'AccountStateError';
  }
}

export function canTransition(from: AccountState, to: AccountState): boolean {
  return ACCOUNT_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: AccountState, to: AccountState): void {
  if (!canTransition(from, to)) throw new AccountStateError(from, to);
}

export function initialAccountState(options: {
  emailVerified: boolean;
  age: number;
  consentAge: number;
}): AccountState {
  if (!options.emailVerified) return 'pending_email_verification';
  return options.age < options.consentAge ? 'pending_parental_consent' : 'active';
}

export interface AccountSummary {
  id: string;
  state: AccountState;
  created_at: Date;
}

export interface Account extends AccountSummary {
  email: string;
  email_verified_at: Date | null;
  date_of_birth: string;
  locale: string | null;
  username: string | null;
  username_updated_at: Date | null;
  public_profile: boolean;
  leaderboard_visible: boolean;
  security_notifications: boolean;
  locked_until: Date | null;
  username_reset_required: boolean;
  deletion_requested_at: Date | null;
}

export interface NewUser {
  state: AccountState;
  email: string;
  emailNormalized: string;
  emailVerifiedAt: Date | null;
  dateOfBirth: string;
  locale: string | null;
  publicProfile: boolean;
  leaderboardVisible: boolean;
  securityNotifications: boolean;
}

export const dateOfBirthColumn = sql<string>`to_char(users.date_of_birth, 'YYYY-MM-DD')`;

export function accountsWithEmail(
  db: Kysely<Database>,
  emailNormalized: string,
): Promise<AccountSummary[]> {
  return db
    .selectFrom('users')
    .select(['id', 'state', 'created_at'])
    .where('email_normalized', '=', emailNormalized)
    .where('state', '!=', 'deleted')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export async function lockEmail(db: Kysely<Database>, emailNormalized: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext('qtiauth.accounts.email'), hashtext(${emailNormalized}))`.execute(
    db,
  );
}

export async function createUser(db: Kysely<Database>, user: NewUser): Promise<string> {
  const id = randomUUIDv7();
  await db
    .insertInto('users')
    .values({
      id,
      state: user.state,
      email: user.email,
      email_normalized: user.emailNormalized,
      email_verified_at: user.emailVerifiedAt,
      date_of_birth: user.dateOfBirth,
      locale: user.locale,
      public_profile: user.publicProfile,
      leaderboard_visible: user.leaderboardVisible,
      security_notifications: user.securityNotifications,
    })
    .execute();
  return id;
}

export function findAccount(db: Kysely<Database>, id: string): Promise<Account | undefined> {
  return db
    .selectFrom('users')
    .select([
      'id',
      'state',
      'email',
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
    ])
    .where('id', '=', id)
    .executeTakeFirst();
}

export async function markEmailVerified(db: Kysely<Database>, id: string, at: Date): Promise<void> {
  await db
    .updateTable('users')
    .set({ email_verified_at: at, updated_at: at })
    .where('id', '=', id)
    .where('email_verified_at', 'is', null)
    .execute();
}

export async function recordIdentityUse(
  db: Kysely<Database>,
  userId: string,
  type: string,
  at: Date,
): Promise<void> {
  await db
    .insertInto('identities')
    .values({
      id: randomUUIDv7(),
      user_id: userId,
      type,
      subject: null,
      secret: null,
      last_used_at: at,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['user_id', 'type'])
        .where('subject', 'is', null)
        .doUpdateSet({ last_used_at: at }),
    )
    .execute();
}

export async function countAccountsByState(
  db: Kysely<Database>,
): Promise<Partial<Record<AccountState, number>>> {
  const rows = await db
    .selectFrom('users')
    .select(['state', (eb) => eb.fn.countAll<string>().as('count')])
    .groupBy('state')
    .execute();
  return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
}

export function findPasswordIdentity(
  db: Kysely<Database>,
  userId: string,
): Promise<{ secret: string | null; last_used_at: Date | null } | undefined> {
  return db
    .selectFrom('identities')
    .select(['secret', 'last_used_at'])
    .where('user_id', '=', userId)
    .where('type', '=', 'password')
    .where('subject', 'is', null)
    .executeTakeFirst();
}

export async function upsertPassword(
  db: Kysely<Database>,
  userId: string,
  hash: string,
  at: Date,
): Promise<void> {
  await db
    .insertInto('identities')
    .values({
      id: randomUUIDv7(),
      user_id: userId,
      type: 'password',
      subject: null,
      secret: hash,
      last_used_at: at,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['user_id', 'type'])
        .where('subject', 'is', null)
        .doUpdateSet({ secret: hash, last_used_at: at }),
    )
    .execute();
}

export async function activateVerifiedEmail(
  db: Kysely<Database>,
  id: string,
  at: Date,
  options?: { age: number; consentAge: number },
): Promise<Account | undefined> {
  await markEmailVerified(db, id, at);
  const account = await findAccount(db, id);
  if (!account) return undefined;
  if (account.state === 'pending_email_verification') {
    const next =
      options === undefined
        ? 'active'
        : initialAccountState({
            emailVerified: true,
            age: options.age,
            consentAge: options.consentAge,
          });
    assertTransition(account.state, next);
    await db
      .updateTable('users')
      .set({ state: next, updated_at: at })
      .where('id', '=', id)
      .where('state', '=', 'pending_email_verification')
      .execute();
    return { ...account, state: next, email_verified_at: account.email_verified_at ?? at };
  }
  return account;
}
