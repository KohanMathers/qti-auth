import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table games (
      id uuid primary key,
      slug text not null unique,
      name text not null,
      description text not null,
      icon text,
      art text,
      status text not null check (
        status in ('draft', 'hidden', 'early_access', 'released', 'archived')
      ),
      lease_duration_seconds integer,
      cloud_save_quota_bytes bigint,
      steam_app_id integer,
      server_client_id text,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create table products (
      id uuid primary key,
      game_id uuid not null references games (id) on delete cascade,
      slug text not null,
      name text not null,
      description text not null,
      type text not null check (type in ('base', 'dlc', 'edition', 'beta_access', 'soundtrack')),
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (game_id, slug)
    )
  `.execute(db);
  await sql`
    create unique index products_one_base_idx on products (game_id) where type = 'base'
  `.execute(db);
  await sql`
    create table entitlements (
      id uuid primary key,
      user_id uuid not null,
      product_id uuid not null references products (id) on delete cascade,
      source text not null check (source in ('admin_grant', 'key_redemption', 'steam', 'api')),
      granted_by uuid,
      granted_at timestamptz not null,
      expires_at timestamptz,
      revoked_at timestamptz,
      revoke_reason text,
      created_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create unique index entitlements_active_source_idx
      on entitlements (user_id, product_id, source)
      where revoked_at is null
  `.execute(db);
  await sql`create index entitlements_user_idx on entitlements (user_id, granted_at desc)`.execute(
    db,
  );
  await sql`
    create index entitlements_due_idx on entitlements (expires_at)
      where revoked_at is null and expires_at is not null
  `.execute(db);
}
