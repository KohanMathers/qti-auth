import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table auth_challenges (
      id uuid primary key,
      token_hash text not null unique,
      user_id uuid references users (id) on delete cascade,
      session_id uuid references sessions (id) on delete cascade,
      kind text not null check (kind in (
        'second_factor', 'passkey_register', 'passkey_authenticate', 'totp_enrol', 'step_up'
      )),
      payload text not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      used_at timestamptz
    )
  `.execute(db);
  await sql`create index auth_challenges_expires_at_idx on auth_challenges (expires_at)`.execute(
    db,
  );
  await sql`
    create table recovery_codes (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      code_hash text not null unique,
      created_at timestamptz not null default now(),
      used_at timestamptz
    )
  `.execute(db);
  await sql`create index recovery_codes_user_id_idx on recovery_codes (user_id)`.execute(db);
  await sql`
    create table user_permissions (
      user_id uuid not null references users (id) on delete cascade,
      permission text not null,
      primary key (user_id, permission)
    )
  `.execute(db);
}
