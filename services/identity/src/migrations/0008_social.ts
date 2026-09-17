import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table auth_challenges drop constraint auth_challenges_kind_check`.execute(db);
  await sql`
    alter table auth_challenges add constraint auth_challenges_kind_check
      check (kind in (
        'second_factor', 'passkey_register', 'passkey_authenticate', 'totp_enrol', 'step_up',
        'social_signup'
      ))
  `.execute(db);
  await sql`alter table email_tokens drop constraint email_tokens_purpose_check`.execute(db);
  await sql`
    alter table email_tokens add constraint email_tokens_purpose_check
      check (purpose in (
        'magic_link', 'signup', 'email_verify', 'password_reset', 'email_change', 'email_revert'
      ))
  `.execute(db);
}
