import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop index session_bindings_session_id_idx`.execute(db);
  await sql`
    alter table session_bindings
      add constraint session_bindings_session_id_cookie_scope_key unique (session_id, cookie_scope)
  `.execute(db);
}
