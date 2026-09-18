import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table users
      add column locked_until timestamptz,
      add column username_reset_required boolean not null default false
  `.execute(db);
  await sql`
    alter table users
      add constraint users_locked_until_check
        check (locked_until is null or state = 'locked')
  `.execute(db);
  await sql`
    create index users_locked_until_idx
      on users (locked_until)
      where state = 'locked' and locked_until is not null
  `.execute(db);
  await sql`
    alter table users
      add column search_vector tsvector generated always as (
        setweight(to_tsvector('simple', coalesce(username, '')), 'A') ||
        setweight(to_tsvector('simple', email), 'B') ||
        setweight(to_tsvector('simple', email_normalized), 'C')
      ) stored
  `.execute(db);
  await sql`create index users_search_vector_idx on users using gin (search_vector)`.execute(db);
  await sql`
    create index users_state_created_at_id_idx on users (state, created_at desc, id desc)
  `.execute(db);
  await sql`
    create table account_actions (
      id uuid primary key,
      user_id uuid not null references users (id) on delete cascade,
      actor_type text not null,
      actor_id text not null,
      action text not null,
      reason text not null,
      from_state text,
      to_state text,
      expires_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index account_actions_user_id_created_at_idx
      on account_actions (user_id, created_at desc)
  `.execute(db);
  await sql`
    alter table session_security_events drop constraint session_security_events_kind_check
  `.execute(db);
  await sql`
    alter table session_security_events
      add constraint session_security_events_kind_check
        check (
          kind in (
            'trust_transition',
            'country_change',
            'new_device',
            'reauthenticated',
            'force_reauth'
          )
        )
  `.execute(db);
}
