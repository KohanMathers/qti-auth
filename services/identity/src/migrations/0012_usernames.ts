import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table users
      add column username text,
      add column username_canonical text,
      add column username_updated_at timestamptz
  `.execute(db);
  await sql`create unique index users_username_canonical_idx on users (username_canonical)`.execute(
    db,
  );
  await sql`
    create table username_history (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      username text not null,
      canonical text not null,
      claimed_at timestamptz not null,
      released_at timestamptz
    )
  `.execute(db);
  await sql`create index username_history_user_id_claimed_at_idx on username_history (user_id, claimed_at desc)`.execute(
    db,
  );
  await sql`create index username_history_canonical_released_at_idx on username_history (canonical, released_at desc)`.execute(
    db,
  );
}
