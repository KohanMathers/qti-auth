import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table users
      add column public_profile boolean not null default false,
      add column leaderboard_visible boolean not null default false,
      add column security_notifications boolean not null default true
  `.execute(db);
  await sql`
    create table age_assurance_results (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      provider text not null,
      strength text not null check (strength in ('self_declared', 'estimated', 'verified')),
      trigger text not null,
      vendor_reference text,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index age_assurance_results_user_id_created_at_idx
    on age_assurance_results (user_id, created_at desc)`.execute(db);
  await sql`
    create table date_of_birth_changes (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      actor_id uuid not null,
      reason text not null,
      previous_date_of_birth date not null,
      date_of_birth date not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index date_of_birth_changes_user_id_created_at_idx
    on date_of_birth_changes (user_id, created_at desc)`.execute(db);
}
