import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table tickets add column guest_email text`.execute(db);
  await sql`
    create table guest_codes (
      id uuid primary key,
      email text not null,
      email_normalized text not null,
      code_hash text not null,
      created_at timestamptz not null,
      expires_at timestamptz not null,
      used_at timestamptz
    )
  `.execute(db);
  await sql`create index guest_codes_email_idx on guest_codes (email_normalized, created_at desc)`.execute(
    db,
  );
  await sql`
    create table guest_links (
      id uuid primary key,
      ticket_id uuid not null references tickets (id) on delete cascade,
      token_hash text not null unique,
      created_at timestamptz not null,
      expires_at timestamptz not null
    )
  `.execute(db);
  await sql`create index guest_links_ticket_idx on guest_links (ticket_id)`.execute(db);
  await sql`
    create table guest_attempts (
      ip text primary key,
      attempts integer not null,
      updated_at timestamptz not null
    )
  `.execute(db);
  await sql`
    create table ticket_attachments (
      id uuid primary key,
      ticket_id uuid not null references tickets (id) on delete cascade,
      object_key text not null,
      filename text not null,
      content_type text not null,
      size_bytes integer not null check (size_bytes > 0),
      created_at timestamptz not null
    )
  `.execute(db);
  await sql`create index ticket_attachments_ticket_idx on ticket_attachments (ticket_id, created_at)`.execute(
    db,
  );
}
