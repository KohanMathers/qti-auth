import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table key_batches (
      id uuid primary key,
      game_id uuid not null references games (id) on delete cascade,
      product_id uuid not null references products (id) on delete cascade,
      label text not null,
      format text not null,
      total_keys integer not null,
      expires_at timestamptz,
      created_by uuid,
      created_at timestamptz not null,
      revoked_at timestamptz,
      revoke_reason text
    )
  `.execute(db);
  await sql`create index key_batches_game_idx on key_batches (game_id, created_at desc)`.execute(
    db,
  );
  await sql`
    create table game_keys (
      id uuid primary key,
      batch_id uuid not null references key_batches (id) on delete cascade,
      code_hash bytea not null unique,
      code_display text not null,
      code_sealed text not null,
      redeemed_by_user_id uuid,
      redeemed_at timestamptz,
      redeemed_ip text,
      entitlement_id uuid,
      revoked_at timestamptz,
      created_at timestamptz not null
    )
  `.execute(db);
  await sql`create index game_keys_batch_idx on game_keys (batch_id, created_at asc)`.execute(db);
  await sql`
    create index game_keys_user_idx on game_keys (redeemed_by_user_id)
      where redeemed_by_user_id is not null
  `.execute(db);
  await sql`
    create table key_redeem_attempts (
      ip text primary key,
      attempts integer not null,
      updated_at timestamptz not null
    )
  `.execute(db);
}
