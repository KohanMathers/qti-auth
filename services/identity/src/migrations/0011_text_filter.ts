import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table filter_decisions (
      id uuid primary key,
      input_hash text not null,
      raw_input text,
      normalized text not null,
      decision text not null check (decision in ('allow', 'block')),
      rule text not null check (
        rule in (
          'allowlist',
          'exact_block',
          'dictionary',
          'token_block',
          'token_padded_loose',
          'padded_loose',
          'unknown'
        )
      ),
      matched_entry text,
      context text not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`create index filter_decisions_created_at_idx on filter_decisions (created_at desc)`.execute(
    db,
  );
  await sql`create index filter_decisions_decision_created_at_idx on filter_decisions (decision, created_at desc)`.execute(
    db,
  );
  await sql`create index filter_decisions_rule_created_at_idx on filter_decisions (rule, created_at desc)`.execute(
    db,
  );
  await sql`
    create table filter_list_entries (
      list text not null check (list in ('allow', 'extra_block')),
      word text not null,
      created_at timestamptz not null default now(),
      primary key (list, word)
    )
  `.execute(db);
}
