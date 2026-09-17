import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sessions drop constraint sessions_revoked_reason_check`.execute(db);
  await sql`
    alter table sessions
      add constraint sessions_revoked_reason_check
        check (revoked_reason in ('logout', 'revoked', 'evicted', 'blocked'))
  `.execute(db);
  await sql`
    alter table sessions
      add column ip text,
      add column ip_subnet text,
      add column country text,
      add column last_country text,
      add column tls_fingerprint text,
      add column timezone text,
      add column screen text,
      add column client_fingerprint text,
      add column device_key text,
      add column trust_level text not null default 'full'
  `.execute(db);
  await sql`
    alter table sessions
      add constraint sessions_trust_level_check
        check (trust_level in ('full', 'partial', 'challenge', 'blocked'))
  `.execute(db);
  await sql`
    create table session_security_events (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      session_id uuid references sessions (id) on delete set null,
      kind text not null check (
        kind in ('trust_transition', 'country_change', 'new_device', 'reauthenticated')
      ),
      trust_from text,
      trust_to text,
      country_from text,
      country_to text,
      notified boolean not null default false,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index session_security_events_user_id_created_at_idx on session_security_events (user_id, created_at desc)`.execute(
    db,
  );
  await sql`create index session_security_events_created_at_idx on session_security_events (created_at)`.execute(
    db,
  );
}
