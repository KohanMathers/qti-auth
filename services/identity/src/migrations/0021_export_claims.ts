import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table data_exports add column started_at timestamptz`.execute(db);
  await sql`
    create index data_exports_pending_idx
      on data_exports (started_at)
      where status = 'pending'
  `.execute(db);
}
