import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table csea_cases (
      id uuid primary key,
      report_id uuid not null unique references reports (id) on delete restrict,
      status text not null check (status in ('open', 'submitted', 'closed', 'destroyed')),
      nca_priority smallint not null check (nca_priority in (1, 2, 3)),
      nca_reference text,
      submitted_at timestamptz,
      submission_deadline timestamptz not null,
      evidence_until timestamptz,
      reference_until timestamptz,
      legal_hold_id uuid,
      target_user_id uuid,
      checklist jsonb not null default '{}'::jsonb,
      closed_reason text,
      actor_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      destroyed_at timestamptz
    )
  `.execute(db);
  await sql`
    create index csea_cases_open_deadline_idx
      on csea_cases (submission_deadline)
      where status = 'open'
  `.execute(db);
  await sql`
    create index csea_cases_evidence_until_idx
      on csea_cases (evidence_until)
      where status = 'submitted' and evidence_until is not null
  `.execute(db);
  await sql`
    create table csea_evidence (
      id uuid primary key,
      case_id uuid not null references csea_cases (id) on delete restrict,
      kind text not null check (kind in ('snapshot', 'metadata')),
      content_type text not null,
      sealed text not null,
      storage_key text,
      created_at timestamptz not null default now(),
      destroyed_at timestamptz
    )
  `.execute(db);
  await sql`create index csea_evidence_case_idx on csea_evidence (case_id, created_at)`.execute(db);
}
