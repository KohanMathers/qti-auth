import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table games
      add column licensing_device_binding boolean not null default false
  `.execute(db);
  await sql`
    create table license_leases (
      id uuid primary key,
      user_id uuid not null,
      game_id uuid not null references games (id) on delete cascade,
      device_hash text,
      device_label text,
      products jsonb not null,
      issued_at timestamptz not null,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      revoke_reason text,
      last_seen_at timestamptz,
      created_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create index license_leases_user_game_idx
      on license_leases (user_id, game_id, issued_at desc)
  `.execute(db);
  await sql`
    create unique index license_leases_user_device_idx
      on license_leases (user_id, game_id, device_hash)
      where revoked_at is null and device_hash is not null
  `.execute(db);
  await sql`
    create index license_leases_game_active_idx
      on license_leases (game_id)
      where revoked_at is null
  `.execute(db);
  await sql`
    create table license_revocations (
      lease_id uuid primary key references license_leases (id) on delete cascade,
      game_id uuid not null references games (id) on delete cascade,
      user_id uuid not null,
      revoked_at timestamptz not null,
      expires_at timestamptz not null,
      reason text
    )
  `.execute(db);
  await sql`
    create index license_revocations_game_idx
      on license_revocations (game_id, revoked_at desc)
  `.execute(db);
  await sql`
    create index license_revocations_expiry_idx
      on license_revocations (expires_at)
  `.execute(db);
}
