import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table clients add column require_par boolean not null default false`.execute(db);
  await sql`alter table access_tokens alter column user_id drop not null`.execute(db);
  await sql`
    create table pushed_authorization_requests (
      id uuid primary key,
      request_uri_hash text not null unique,
      client_id uuid not null references clients (id) on delete cascade,
      redirect_uri text not null,
      scopes text[] not null,
      state text,
      nonce text,
      code_challenge text not null,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index pushed_authorization_requests_expires_idx
      on pushed_authorization_requests (expires_at)
  `.execute(db);
  await sql`
    create table device_authorizations (
      id uuid primary key,
      device_code_hash text not null unique,
      user_code_hash text not null unique,
      client_id uuid not null references clients (id) on delete cascade,
      scopes text[] not null,
      interval_ms integer not null,
      last_polled_at timestamptz,
      status text not null check (status in ('pending', 'authorized', 'denied')),
      user_id uuid,
      session_id text,
      auth_time timestamptz,
      amr text[],
      acr text,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index device_authorizations_user_id_idx on device_authorizations (user_id)
      where user_id is not null
  `.execute(db);
  await sql`
    create index device_authorizations_expires_idx on device_authorizations (expires_at)
  `.execute(db);
}
