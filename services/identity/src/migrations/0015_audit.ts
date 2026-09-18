import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table audit_log (
      seq bigint primary key,
      event_id text not null unique,
      occurred_at timestamptz not null,
      actor_type text not null,
      actor_id text not null,
      action text not null,
      target_type text not null,
      target_id text not null,
      prev_hash text not null,
      row_hash text not null
    )
  `.execute(db);
  await sql`create index audit_log_actor_id_seq_idx on audit_log (actor_id, seq desc)`.execute(db);
  await sql`create index audit_log_action_seq_idx on audit_log (action, seq desc)`.execute(db);
  await sql`create index audit_log_target_seq_idx on audit_log (target_type, target_id, seq desc)`.execute(
    db,
  );
  await sql`create index audit_log_occurred_at_seq_idx on audit_log (occurred_at, seq desc)`.execute(
    db,
  );
}
