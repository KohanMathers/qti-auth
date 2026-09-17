import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table email_tokens (
      id uuid primary key,
      purpose text not null check (purpose in ('magic_link', 'signup')),
      token_hash text not null unique,
      email text not null,
      email_normalized text not null,
      locale text,
      return_to text,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      used_at timestamptz
    )
  `.execute(db);
  await sql`create index email_tokens_expires_at_idx on email_tokens (expires_at)`.execute(db);
  await sql`create index email_tokens_email_normalized_idx on email_tokens (email_normalized)`.execute(
    db,
  );
}
