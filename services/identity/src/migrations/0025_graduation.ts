import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table graduation_notices (
      user_id uuid primary key references users (id) on delete cascade,
      notified_at timestamptz not null,
      consent_age integer not null
    )
  `.execute(db);
  await sql`
    create table guardian_removal_requests (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      status text not null check (status in ('pending', 'approved', 'declined', 'cancelled', 'completed')),
      requested_at timestamptz not null,
      decided_at timestamptz,
      last_reminded_at timestamptz
    )
  `.execute(db);
  await sql`
    create unique index guardian_removal_requests_one_pending_idx
      on guardian_removal_requests (user_id) where status = 'pending'
  `.execute(db);
}
