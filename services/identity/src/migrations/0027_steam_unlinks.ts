import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table steam_unlinks (
      steam_id text primary key,
      unlinked_at timestamptz not null,
      cooldown_until timestamptz not null
    )
  `.execute(db);
  await sql`create index steam_unlinks_cooldown_idx on steam_unlinks (cooldown_until)`.execute(db);
}
