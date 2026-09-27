import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table stat_definitions (
      id uuid primary key,
      game_id uuid not null references games (id) on delete cascade,
      key text not null,
      type text not null,
      aggregation text not null,
      authority text not null,
      max_delta_per_update double precision,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (game_id, key)
    )
  `.execute(db);
  await sql`
    create table stat_values (
      stat_id uuid not null references stat_definitions (id) on delete cascade,
      user_id uuid not null,
      value double precision not null,
      updates integer not null,
      updated_at timestamptz not null,
      created_at timestamptz not null,
      primary key (stat_id, user_id)
    )
  `.execute(db);
  await sql`
    create index stat_values_user_idx on stat_values (user_id)
  `.execute(db);
  await sql`
    create table stat_custom_data (
      game_id uuid not null references games (id) on delete cascade,
      user_id uuid not null,
      data jsonb not null,
      updated_at timestamptz not null,
      primary key (game_id, user_id)
    )
  `.execute(db);
  await sql`
    create table leaderboards (
      id uuid primary key,
      stat_id uuid not null references stat_definitions (id) on delete cascade,
      slug text not null,
      name text not null,
      sort text not null,
      reset_period text not null,
      period_started_at timestamptz not null,
      period_ends_at timestamptz,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      unique (stat_id, slug)
    )
  `.execute(db);
  await sql`
    create table leaderboard_entries (
      leaderboard_id uuid not null references leaderboards (id) on delete cascade,
      period_started_at timestamptz not null,
      user_id uuid not null,
      score double precision not null,
      hidden boolean not null,
      removed_at timestamptz,
      removed_reason text,
      updated_at timestamptz not null,
      primary key (leaderboard_id, period_started_at, user_id)
    )
  `.execute(db);
  await sql`
    create index leaderboard_entries_rank_idx
      on leaderboard_entries (leaderboard_id, period_started_at, score)
      where removed_at is null
  `.execute(db);
  await sql`
    create table playtime_sessions (
      id uuid primary key,
      user_id uuid not null,
      game_id uuid not null references games (id) on delete cascade,
      started_at timestamptz not null,
      last_heartbeat_at timestamptz not null,
      ended_at timestamptz,
      duration_seconds integer not null,
      created_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create index playtime_sessions_user_idx on playtime_sessions (user_id, started_at desc)
  `.execute(db);
  await sql`
    create index playtime_sessions_open_idx
      on playtime_sessions (user_id, game_id)
      where ended_at is null
  `.execute(db);
  await sql`
    create table playtime_daily (
      user_id uuid not null,
      game_id uuid not null references games (id) on delete cascade,
      day date not null,
      seconds integer not null,
      updated_at timestamptz not null,
      primary key (user_id, game_id, day)
    )
  `.execute(db);
}
