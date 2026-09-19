import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table clients
      add column backchannel_logout_uri text,
      add column backchannel_logout_session_required boolean not null default false
  `.execute(db);
  await sql`
    create table logout_deliveries (
      id uuid primary key,
      client_id uuid not null references clients (id) on delete cascade,
      user_id uuid not null,
      session_id text not null,
      uri text not null,
      cause text not null check (cause in ('session', 'lock', 'ban', 'deletion')),
      status text not null check (status in ('retrying', 'sent', 'failed')),
      attempts integer not null,
      next_attempt_at timestamptz,
      queued_at timestamptz not null,
      sent_at timestamptz,
      last_error text,
      response_status integer,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index logout_deliveries_due_idx
      on logout_deliveries (next_attempt_at)
      where status = 'retrying'
  `.execute(db);
  await sql`
    create index logout_deliveries_client_id_idx
      on logout_deliveries (client_id, queued_at desc)
  `.execute(db);
  await sql`
    create index logout_deliveries_user_id_idx on logout_deliveries (user_id)
  `.execute(db);
}
