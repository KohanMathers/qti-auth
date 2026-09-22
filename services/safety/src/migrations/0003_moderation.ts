import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table moderation_actions (
      id uuid primary key,
      report_id uuid not null references reports (id) on delete cascade,
      user_id uuid,
      action text not null check (
        action in (
          'warn',
          'restrict',
          'force_username_reset',
          'lock',
          'ban',
          'remove_content',
          'proscribed_org_removal'
        )
      ),
      status text not null check (status in ('applied', 'pending_approval', 'lifted')),
      rule_id text not null,
      restrictions text[] not null default '{}',
      expires_at timestamptz,
      reason_code text,
      actor_id uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index moderation_actions_report_idx on moderation_actions (report_id, created_at)
  `.execute(db);
  await sql`
    create index moderation_actions_user_idx
      on moderation_actions (user_id, created_at desc)
      where user_id is not null
  `.execute(db);
  await sql`
    create index moderation_actions_actor_idx on moderation_actions (actor_id, created_at desc)
  `.execute(db);
  await sql`
    create table action_approvals (
      id uuid primary key,
      report_id uuid not null references reports (id) on delete cascade,
      action_id uuid not null references moderation_actions (id) on delete cascade,
      requested_by uuid not null,
      approved_by uuid,
      status text not null check (status in ('pending', 'approved', 'cancelled')),
      created_at timestamptz not null default now(),
      decided_at timestamptz
    )
  `.execute(db);
  await sql`
    create unique index action_approvals_pending_idx
      on action_approvals (action_id)
      where status = 'pending'
  `.execute(db);
  await sql`
    create table appeals (
      id uuid primary key,
      action_id uuid not null references moderation_actions (id) on delete cascade,
      user_id uuid,
      body text not null,
      status text not null check (status in ('open', 'lifted', 'upheld')),
      ticket_id text,
      resolved_by uuid,
      created_at timestamptz not null default now(),
      resolved_at timestamptz
    )
  `.execute(db);
  await sql`
    create unique index appeals_open_action_idx
      on appeals (action_id)
      where status = 'open'
  `.execute(db);
  await sql`create index appeals_user_idx on appeals (user_id, created_at desc)`.execute(db);
}
