import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table users
      add column pre_deletion_state text
        check (pre_deletion_state in ('active', 'locked', 'banned'))
  `.execute(db);
}
