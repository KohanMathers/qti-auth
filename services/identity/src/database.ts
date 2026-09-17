import type { AccountState } from '@qtiauth/service-kit';
import type { ColumnType, Generated } from 'kysely';

export const REVOCATION_REASONS = ['logout', 'revoked', 'evicted'] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

export const EMAIL_TOKEN_PURPOSES = ['magic_link', 'signup'] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

export interface UsersTable {
  id: string;
  state: AccountState;
  email: string;
  email_normalized: string;
  email_verified_at: Date | null;
  date_of_birth: ColumnType<never, string, string>;
  locale: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface IdentitiesTable {
  id: string;
  user_id: string;
  type: string;
  subject: string | null;
  created_at: Generated<Date>;
  last_used_at: Date | null;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  auth_method: string;
  amr: string[];
  acr: string;
  step_up_at: Date | null;
  user_agent: string | null;
  created_at: Generated<Date>;
  last_active_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: RevocationReason | null;
}

export interface SessionBindingsTable {
  id: string;
  session_id: string;
  token_hash: string;
  cookie_scope: string;
  created_at: Generated<Date>;
}

export interface EmailTokensTable {
  id: string;
  purpose: EmailTokenPurpose;
  token_hash: string;
  email: string;
  email_normalized: string;
  locale: string | null;
  return_to: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
  used_at: Date | null;
}

export interface Database {
  users: UsersTable;
  identities: IdentitiesTable;
  sessions: SessionsTable;
  session_bindings: SessionBindingsTable;
  email_tokens: EmailTokensTable;
}
