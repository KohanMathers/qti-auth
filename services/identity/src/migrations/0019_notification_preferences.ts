import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table notification_preferences (
      user_id uuid not null references users (id) on delete cascade,
      category text not null,
      enabled boolean not null,
      updated_at timestamptz not null default now(),
      primary key (user_id, category)
    )
  `.execute(db);
}
