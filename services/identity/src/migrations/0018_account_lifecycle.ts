import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table users
      add column deletion_requested_at timestamptz
  `.execute(db);
  await sql`
    alter table users
      add constraint users_deletion_requested_at_check
        check (deletion_requested_at is null or state = 'pending_deletion')
  `.execute(db);
  await sql`
    create index users_deletion_requested_at_idx
      on users (deletion_requested_at)
      where state = 'pending_deletion' and deletion_requested_at is not null
  `.execute(db);
  await sql`
    create table data_exports (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      status text not null check (status in ('pending', 'ready', 'failed', 'unavailable')),
      object_key text,
      bytes integer,
      download_expires_at timestamptz,
      error text,
      created_at timestamptz not null default now(),
      completed_at timestamptz
    )
  `.execute(db);
  await sql`
    create index data_exports_user_id_created_at_idx
      on data_exports (user_id, created_at desc)
  `.execute(db);
  await sql`
    create table legal_holds (
      id uuid primary key,
      user_id uuid not null,
      reason text not null,
      case_id text,
      actor_type text not null,
      actor_id text not null,
      placed_at timestamptz not null default now(),
      lifted_at timestamptz
    )
  `.execute(db);
  await sql`
    create index legal_holds_user_id_placed_at_idx
      on legal_holds (user_id, placed_at desc)
  `.execute(db);
  await sql`
    create unique index legal_holds_one_active_idx
      on legal_holds (user_id)
      where lifted_at is null
  `.execute(db);
  await sql`
    create table deletion_ledger_outbox (
      id bigint generated always as identity primary key,
      user_id uuid not null unique,
      deleted_at timestamptz not null,
      created_at timestamptz not null default now(),
      sent_at timestamptz
    )
  `.execute(db);
  await sql`
    create index deletion_ledger_outbox_unsent_idx
      on deletion_ledger_outbox (id)
      where sent_at is null
  `.execute(db);
}
