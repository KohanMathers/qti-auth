import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table guardians (
      id uuid primary key,
      child_user_id uuid not null references users (id) on delete cascade,
      email text not null,
      email_normalized text not null,
      user_id uuid references users (id) on delete set null,
      display_name text,
      status text not null check (status in ('pending', 'active', 'revoked')),
      invited_by uuid references guardians (id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      accepted_at timestamptz,
      revoked_at timestamptz
    )
  `.execute(db);
  await sql`
    create unique index guardians_child_email_idx
      on guardians (child_user_id, email_normalized) where status in ('pending', 'active')
  `.execute(db);
  await sql`
    create index guardians_email_active_idx
      on guardians (email_normalized) where status = 'active'
  `.execute(db);
  await sql`
    create index guardians_user_active_idx
      on guardians (user_id) where status = 'active' and user_id is not null
  `.execute(db);
  await sql`
    create table parental_controls (
      user_id uuid primary key references users (id) on delete cascade,
      online_play boolean not null default false,
      in_game_chat boolean not null default false,
      user_generated_content boolean not null default false,
      purchases boolean not null default false,
      daily_playtime_minutes integer
        check (daily_playtime_minutes is null or daily_playtime_minutes >= 0),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create table username_change_requests (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      username text not null,
      canonical text not null,
      status text not null check (status in ('pending', 'approved', 'declined', 'cancelled')),
      requested_at timestamptz not null,
      decided_at timestamptz
    )
  `.execute(db);
  await sql`
    create unique index username_change_requests_one_pending_idx
      on username_change_requests (user_id) where status = 'pending'
  `.execute(db);
  await sql`
    create table family_sessions (
      id uuid primary key,
      token_hash text not null unique,
      email text not null,
      email_normalized text not null,
      created_at timestamptz not null default now(),
      last_active_at timestamptz not null,
      expires_at timestamptz not null,
      revoked_at timestamptz
    )
  `.execute(db);
  await sql`
    create index family_sessions_email_idx on family_sessions (email_normalized)
  `.execute(db);
  await sql`
    create table family_activity_notices (
      child_user_id uuid not null references users (id) on delete cascade,
      period_start date not null,
      sent_at timestamptz not null,
      primary key (child_user_id, period_start)
    )
  `.execute(db);
  await sql`alter table email_tokens drop constraint email_tokens_purpose_check`.execute(db);
  await sql`
    alter table email_tokens add constraint email_tokens_purpose_check
      check (purpose in (
        'magic_link', 'signup', 'email_verify', 'password_reset', 'email_change', 'email_revert',
        'admin_signup', 'parental_approve', 'parental_decline', 'family_access', 'family_invite'
      ))
  `.execute(db);
}
