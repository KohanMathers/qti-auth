import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table clients (
      id uuid primary key,
      client_id text not null unique,
      name text not null,
      type text not null check (type in ('public', 'confidential')),
      secret_hash text,
      first_party boolean not null,
      verified boolean not null,
      redirect_uris jsonb not null,
      allowed_scopes jsonb,
      suspended_at timestamptz,
      owner_user_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create table consents (
      user_id uuid not null,
      client_id uuid not null references clients (id) on delete cascade,
      scopes text[] not null,
      granted_at timestamptz not null,
      primary key (user_id, client_id)
    )
  `.execute(db);
  await sql`create index consents_client_id_idx on consents (client_id)`.execute(db);
  await sql`
    create table authorization_requests (
      id uuid primary key,
      client_id uuid not null references clients (id) on delete cascade,
      user_id uuid not null,
      session_id text not null,
      redirect_uri text not null,
      scopes text[] not null,
      state text,
      nonce text,
      code_challenge text not null,
      auth_time timestamptz not null,
      amr text[] not null,
      acr text not null,
      expires_at timestamptz not null,
      completed_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index authorization_requests_user_id_idx
      on authorization_requests (user_id, created_at desc)
  `.execute(db);
  await sql`
    create table authorization_codes (
      id uuid primary key,
      code_hash text not null unique,
      client_id uuid not null references clients (id) on delete cascade,
      user_id uuid not null,
      session_id text not null,
      redirect_uri text not null,
      scopes text[] not null,
      nonce text,
      code_challenge text not null,
      auth_time timestamptz not null,
      amr text[] not null,
      acr text not null,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index authorization_codes_user_id_idx on authorization_codes (user_id)
  `.execute(db);
  await sql`
    create table refresh_tokens (
      id uuid primary key,
      token_hash text not null unique,
      family_id uuid not null,
      client_id uuid not null references clients (id) on delete cascade,
      user_id uuid not null,
      session_id text,
      scopes text[] not null,
      expires_at timestamptz not null,
      rotated_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index refresh_tokens_family_id_idx on refresh_tokens (family_id)`.execute(db);
  await sql`create index refresh_tokens_user_id_idx on refresh_tokens (user_id)`.execute(db);
  await sql`
    create table access_tokens (
      id uuid primary key,
      client_id uuid not null references clients (id) on delete cascade,
      user_id uuid not null,
      session_id text,
      scopes text[] not null,
      amr text[] not null,
      acr text not null,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      refresh_id uuid references refresh_tokens (id) on delete set null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index access_tokens_user_id_idx on access_tokens (user_id)`.execute(db);
  await sql`
    create index access_tokens_expires_idx on access_tokens (expires_at)
      where revoked_at is null
  `.execute(db);
}
