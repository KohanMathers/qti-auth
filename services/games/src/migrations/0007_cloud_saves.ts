import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table cloud_save_slots (
      id uuid primary key,
      user_id uuid not null,
      game_id uuid not null references games (id) on delete cascade,
      slot text not null,
      current_version_id uuid,
      size_bytes bigint not null default 0,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create unique index cloud_save_slots_user_game_slot_idx
      on cloud_save_slots (user_id, game_id, slot)
  `.execute(db);
  await sql`
    create index cloud_save_slots_user_game_idx
      on cloud_save_slots (user_id, game_id, updated_at desc)
  `.execute(db);
  await sql`
    create table cloud_save_versions (
      id uuid primary key,
      slot_id uuid not null references cloud_save_slots (id) on delete cascade,
      version integer not null,
      size_bytes bigint not null,
      object_key text not null,
      content_type text not null,
      committed_at timestamptz,
      created_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create unique index cloud_save_versions_slot_version_idx
      on cloud_save_versions (slot_id, version)
  `.execute(db);
  await sql`
    create index cloud_save_versions_slot_created_idx
      on cloud_save_versions (slot_id, created_at desc)
  `.execute(db);
  await sql`
    create index cloud_save_versions_pending_idx
      on cloud_save_versions (created_at)
      where committed_at is null
  `.execute(db);
  await sql`
    alter table cloud_save_slots
      add constraint cloud_save_slots_current_version_fkey
      foreign key (current_version_id) references cloud_save_versions (id) on delete set null
  `.execute(db);
}
