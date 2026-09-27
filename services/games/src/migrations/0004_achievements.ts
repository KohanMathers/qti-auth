import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table achievements (
      id uuid primary key,
      game_id uuid not null references games (id) on delete cascade,
      slug text not null,
      name text not null,
      description text not null,
      icon text,
      points integer not null,
      hidden boolean not null,
      progress_target integer,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (game_id, slug)
    )
  `.execute(db);
  await sql`
    create table achievement_unlocks (
      id uuid primary key,
      achievement_id uuid not null references achievements (id) on delete cascade,
      user_id uuid not null,
      progress integer not null,
      unlocked_at timestamptz,
      revoked_at timestamptz,
      revoke_reason text,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (achievement_id, user_id)
    )
  `.execute(db);
  await sql`
    create index achievement_unlocks_user_idx
      on achievement_unlocks (user_id, unlocked_at desc)
      where unlocked_at is not null and revoked_at is null
  `.execute(db);
  await sql`
    create index achievement_unlocks_game_idx
      on achievement_unlocks (achievement_id)
      where unlocked_at is not null and revoked_at is null
  `.execute(db);
  await sql`
    create table achievement_rarity (
      achievement_id uuid primary key references achievements (id) on delete cascade,
      owners integer not null,
      unlocks integer not null,
      rarity double precision not null,
      computed_at timestamptz not null
    )
  `.execute(db);
}
