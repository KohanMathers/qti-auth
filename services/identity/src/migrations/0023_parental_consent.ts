import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table parental_consents (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      guardian_email text not null,
      guardian_email_normalized text not null,
      guardian_date_of_birth date,
      email_changes integer not null default 0,
      status text not null check (status in ('pending', 'granted', 'declined', 'expired')),
      requested_at timestamptz not null,
      decided_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create unique index parental_consents_one_pending_idx
      on parental_consents (user_id) where status = 'pending'
  `.execute(db);
  await sql`
    create index parental_consents_pending_requested_at_idx
      on parental_consents (requested_at) where status = 'pending'
  `.execute(db);
  await sql`alter table email_tokens drop constraint email_tokens_purpose_check`.execute(db);
  await sql`
    alter table email_tokens add constraint email_tokens_purpose_check
      check (purpose in (
        'magic_link', 'signup', 'email_verify', 'password_reset', 'email_change', 'email_revert',
        'admin_signup', 'parental_approve', 'parental_decline'
      ))
  `.execute(db);
}
