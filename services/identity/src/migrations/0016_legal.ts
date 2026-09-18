import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table legal_versions (
      id text not null,
      version text not null,
      effective_at timestamptz not null,
      material boolean not null,
      summary text not null,
      body text not null,
      body_hash text not null,
      published_at timestamptz,
      created_at timestamptz not null default now(),
      primary key (id, version)
    )
  `.execute(db);
  await sql`
    create index legal_versions_effective_at_idx
      on legal_versions (id, effective_at desc, version desc)
  `.execute(db);
  await sql`
    create table legal_acceptances (
      user_id uuid not null references users (id) on delete cascade,
      document_id text not null,
      version text not null,
      accepted_at timestamptz not null,
      ip text,
      method text not null,
      primary key (user_id, document_id, version),
      foreign key (document_id, version) references legal_versions (id, version)
    )
  `.execute(db);
  await sql`
    create index legal_acceptances_user_id_accepted_at_idx
      on legal_acceptances (user_id, accepted_at desc)
  `.execute(db);
}
