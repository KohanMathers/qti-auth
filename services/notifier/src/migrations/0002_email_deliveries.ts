import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table email_deliveries (
      id uuid primary key,
      template text not null,
      locale text not null,
      category text not null,
      priority text not null,
      recipient text not null,
      user_id uuid,
      status text not null check (status in ('retrying', 'sent', 'failed')),
      attempts integer not null check (attempts > 0),
      provider text not null,
      provider_message_id text,
      last_error text,
      queued_at timestamptz not null,
      sent_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index email_deliveries_user_id_idx on email_deliveries (user_id) where user_id is not null`.execute(
    db,
  );
  await sql`create index email_deliveries_created_at_idx on email_deliveries (created_at)`.execute(
    db,
  );
}
