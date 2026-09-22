import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table user_restrictions (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      name text not null,
      action_id uuid not null,
      expires_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create unique index user_restrictions_user_name_idx on user_restrictions (user_id, name)
  `.execute(db);
  await sql`
    create index user_restrictions_expiry_idx
      on user_restrictions (expires_at)
      where expires_at is not null
  `.execute(db);
}
