import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table identities add column secret text`.execute(db);
  await sql`alter table email_tokens add column user_id uuid references users (id) on delete cascade`.execute(
    db,
  );
  await sql`alter table email_tokens drop constraint email_tokens_purpose_check`.execute(db);
  await sql`
    alter table email_tokens add constraint email_tokens_purpose_check
      check (purpose in ('magic_link', 'signup', 'email_verify', 'password_reset'))
  `.execute(db);
  await sql`
    create table auth_failures (
      kind text not null check (kind in ('ip', 'account')),
      key text not null,
      failures integer not null,
      updated_at timestamptz not null,
      primary key (kind, key)
    )
  `.execute(db);
}
