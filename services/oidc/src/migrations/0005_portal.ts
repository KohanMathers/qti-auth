import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table clients
      add column description text not null default ''
  `.execute(db);
  await sql`
    create index clients_owner_user_id_idx
      on clients (owner_user_id)
      where owner_user_id is not null
  `.execute(db);
}
