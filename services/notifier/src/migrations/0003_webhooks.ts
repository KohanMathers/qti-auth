import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table webhook_endpoints (
      id uuid primary key,
      slug text unique,
      url text not null,
      description text not null,
      events jsonb not null,
      format text not null check (format in ('standard', 'discord', 'slack')),
      secret text not null,
      previous_secret text,
      previous_secret_expires_at timestamptz,
      enabled boolean not null,
      consecutive_failures integer not null check (consecutive_failures >= 0),
      disabled_reason text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create table webhook_deliveries (
      id uuid primary key,
      endpoint_id uuid not null references webhook_endpoints (id) on delete cascade,
      event_id text not null,
      event_type text not null,
      trigger text not null check (trigger in ('event', 'test', 'replay')),
      replay_of uuid references webhook_deliveries (id) on delete set null,
      subject_type text,
      subject_id text,
      payload jsonb not null,
      status text not null check (status in ('retrying', 'sent', 'failed')),
      attempts integer not null check (attempts >= 0),
      next_attempt_at timestamptz,
      queued_at timestamptz not null,
      sent_at timestamptz,
      last_error text,
      request_url text,
      request_headers jsonb,
      request_body text,
      response_status integer,
      response_headers jsonb,
      response_body text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index webhook_deliveries_due_idx
      on webhook_deliveries (next_attempt_at)
      where status = 'retrying'
  `.execute(db);
  await sql`
    create index webhook_deliveries_endpoint_id_idx
      on webhook_deliveries (endpoint_id, created_at desc)
  `.execute(db);
  await sql`
    create index webhook_deliveries_subject_idx
      on webhook_deliveries (subject_id)
      where subject_type = 'user' and subject_id is not null
  `.execute(db);
}
