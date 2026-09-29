import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table legal_versions
      add column notice_cursor uuid,
      add column notices_sent_at timestamptz
  `.execute(db);
  await sql`
    update legal_versions set notices_sent_at = published_at where published_at is not null
  `.execute(db);
}
