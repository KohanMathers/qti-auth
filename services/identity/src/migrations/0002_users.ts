import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table users (
      id uuid primary key,
      state text not null check (state in (
        'pending_email_verification', 'pending_parental_consent', 'active', 'locked', 'banned',
        'pending_deletion', 'deleted'
      )),
      email text not null,
      email_normalized text not null,
      email_verified_at timestamptz,
      date_of_birth date not null,
      locale text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index users_email_normalized_idx on users (email_normalized)`.execute(db);
  await sql`
    create table identities (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      type text not null,
      subject text,
      created_at timestamptz not null default now(),
      last_used_at timestamptz
    )
  `.execute(db);
  await sql`create unique index identities_type_subject_idx on identities (type, subject) where subject is not null`.execute(
    db,
  );
  await sql`create unique index identities_user_type_idx on identities (user_id, type) where subject is null`.execute(
    db,
  );
}
