import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table authorization_requests
      add column guardian_status text not null default 'none'
        check (guardian_status in ('none', 'pending', 'approved', 'declined'))
  `.execute(db);
  await sql`
    create unique index authorization_requests_one_pending_guardian_idx
      on authorization_requests (user_id, client_id)
      where guardian_status = 'pending'
  `.execute(db);
  await sql`
    alter table device_authorizations
      drop constraint device_authorizations_status_check
  `.execute(db);
  await sql`
    alter table device_authorizations
      add constraint device_authorizations_status_check
      check (status in ('pending', 'pending_guardian', 'authorized', 'denied'))
  `.execute(db);
}
