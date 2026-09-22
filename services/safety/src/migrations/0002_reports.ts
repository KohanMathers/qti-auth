import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table reports (
      id uuid primary key,
      status text not null check (status in ('open', 'triaged', 'resolved', 'dismissed')),
      type text not null,
      subtype text not null,
      priority text not null check (priority in ('low', 'normal', 'high', 'urgent')),
      csea boolean not null default false,
      target_type text not null check (target_type in ('user', 'content')),
      target_id text not null,
      target_user_id uuid,
      source text not null check (source in ('user', 'game', 'service', 'automated')),
      reporter_user_id uuid,
      reporter_contact text,
      reporter_locale text,
      game_id text,
      client_id text,
      classifier text,
      classifier_score double precision,
      note text,
      context jsonb,
      sla_deadline timestamptz not null,
      sla_breach_notified_at timestamptz,
      outcome text,
      outcome_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index reports_open_deadline_idx
      on reports (sla_deadline)
      where status in ('open', 'triaged') and sla_breach_notified_at is null
  `.execute(db);
  await sql`
    create index reports_target_user_idx
      on reports (target_user_id)
      where target_user_id is not null
  `.execute(db);
  await sql`
    create index reports_reporter_user_idx
      on reports (reporter_user_id, created_at desc)
      where reporter_user_id is not null
  `.execute(db);
  await sql`create index reports_status_priority_idx on reports (status, priority, created_at)`.execute(
    db,
  );
  await sql`
    create table report_snapshots (
      report_id uuid not null references reports (id) on delete cascade,
      content_type text not null,
      content text not null,
      captured_at timestamptz not null,
      created_at timestamptz not null default now(),
      primary key (report_id, captured_at)
    )
  `.execute(db);
}
