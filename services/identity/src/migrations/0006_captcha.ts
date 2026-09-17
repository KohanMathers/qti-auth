import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table auth_failures add column scope text not null default 'password'`.execute(
    db,
  );
  await sql`alter table auth_failures drop constraint auth_failures_pkey`.execute(db);
  await sql`
    alter table auth_failures add constraint auth_failures_pkey primary key (kind, key, scope)
  `.execute(db);
  await sql`
    alter table auth_failures add constraint auth_failures_scope_check
      check (scope in ('password', 'magic_link', 'signup'))
  `.execute(db);
}
