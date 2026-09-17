import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table sessions (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      auth_method text not null,
      amr text[] not null,
      acr text not null check (acr in ('aal0', 'aal1', 'aal2')),
      step_up_at timestamptz,
      user_agent text,
      created_at timestamptz not null default now(),
      last_active_at timestamptz not null,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      revoked_reason text check (revoked_reason in ('logout', 'revoked', 'evicted')),
      check ((revoked_at is null) = (revoked_reason is null))
    )
  `.execute(db);
  await sql`create index sessions_user_id_idx on sessions (user_id, created_at) where revoked_at is null`.execute(
    db,
  );
  await sql`create index sessions_expires_at_idx on sessions (expires_at)`.execute(db);
  await sql`create index sessions_last_active_at_idx on sessions (last_active_at)`.execute(db);
  await sql`create index sessions_revoked_at_idx on sessions (revoked_at) where revoked_at is not null`.execute(
    db,
  );
  await sql`
    create table session_bindings (
      id uuid primary key,
      session_id uuid not null references sessions (id) on delete cascade,
      token_hash text not null unique,
      cookie_scope text not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index session_bindings_session_id_idx on session_bindings (session_id)`.execute(
    db,
  );
}
