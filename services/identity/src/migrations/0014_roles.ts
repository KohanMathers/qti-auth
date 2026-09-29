import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop table user_permissions`.execute(db);
  await sql`
    create table roles (
      id uuid primary key,
      slug text not null unique,
      name text not null,
      description text not null,
      builtin boolean not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create table role_permissions (
      role_id uuid not null references roles (id) on delete cascade,
      permission text not null,
      primary key (role_id, permission)
    )
  `.execute(db);
  await sql`
    create table user_roles (
      user_id uuid not null references users (id) on delete cascade,
      role_id uuid not null references roles (id) on delete cascade,
      primary key (user_id, role_id)
    )
  `.execute(db);
  await sql`create index user_roles_role_id_idx on user_roles (role_id)`.execute(db);
  await sql`alter table email_tokens drop constraint email_tokens_purpose_check`.execute(db);
  await sql`
    alter table email_tokens add constraint email_tokens_purpose_check
      check (purpose in (
        'magic_link', 'signup', 'email_verify', 'password_reset', 'email_change', 'email_revert',
        'admin_signup'
      ))
  `.execute(db);
}
