import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create sequence ticket_number_seq as integer start with 1`.execute(db);
  await sql`
    create table tickets (
      id uuid primary key,
      number integer not null unique default nextval('ticket_number_seq'),
      user_id uuid,
      category_id text not null,
      subject text not null,
      status text not null check (status in ('open', 'pending', 'closed')),
      priority text not null check (priority in ('low', 'normal', 'high', 'urgent')),
      appeal boolean not null default false,
      action_id uuid,
      assigned_to uuid,
      rating integer check (rating is null or rating between 1 and 5),
      first_response_at timestamptz,
      waiting_since timestamptz not null,
      reminder_sent_at timestamptz,
      resolved_at timestamptz,
      created_at timestamptz not null,
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index tickets_user_created_idx on tickets (user_id, created_at desc)`.execute(
    db,
  );
  await sql`create index tickets_queue_idx on tickets (status, priority, created_at)`.execute(db);
  await sql`create index tickets_assigned_idx on tickets (assigned_to) where assigned_to is not null`.execute(
    db,
  );
  await sql`
    create unique index tickets_open_appeal_action_idx
      on tickets (user_id, action_id)
      where status <> 'closed' and appeal and action_id is not null and user_id is not null
  `.execute(db);
  await sql`
    create unique index tickets_open_appeal_user_idx
      on tickets (user_id)
      where status <> 'closed' and appeal and action_id is null and user_id is not null
  `.execute(db);
  await sql`
    create table ticket_messages (
      id uuid primary key,
      ticket_id uuid not null references tickets (id) on delete cascade,
      author_id uuid,
      staff boolean not null,
      body text not null,
      created_at timestamptz not null
    )
  `.execute(db);
  await sql`create index ticket_messages_ticket_idx on ticket_messages (ticket_id, created_at)`.execute(
    db,
  );
  await sql`
    create table ticket_notes (
      id uuid primary key,
      ticket_id uuid not null references tickets (id) on delete cascade,
      author_id uuid not null,
      body text not null,
      created_at timestamptz not null
    )
  `.execute(db);
  await sql`create index ticket_notes_ticket_idx on ticket_notes (ticket_id, created_at)`.execute(
    db,
  );
  await sql`
    create table macros (
      id uuid primary key,
      name text not null,
      body text not null,
      created_by uuid not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    )
  `.execute(db);
  await sql`create index macros_name_idx on macros (name)`.execute(db);
}
