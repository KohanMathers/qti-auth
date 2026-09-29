import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table users drop constraint users_locked_until_check`.execute(db);
  await sql`
    alter table users
      add constraint users_locked_until_check
        check (locked_until is null or state in ('locked', 'pending_deletion'))
  `.execute(db);
}
