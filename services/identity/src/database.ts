import type { AccountState } from '@qtiauth/service-kit';
import type { ColumnType, Generated } from 'kysely';

export const REVOCATION_REASONS = ['logout', 'revoked', 'evicted', 'blocked'] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

export const EMAIL_TOKEN_PURPOSES = [
  'magic_link',
  'signup',
  'email_verify',
  'password_reset',
  'email_change',
  'email_revert',
  'admin_signup',
] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

export const AUTH_FAILURE_KINDS = ['ip', 'account'] as const;
export type AuthFailureKind = (typeof AUTH_FAILURE_KINDS)[number];

export const AUTH_FAILURE_SCOPES = ['password', 'magic_link', 'signup'] as const;
export type AuthFailureScope = (typeof AUTH_FAILURE_SCOPES)[number];

export const SECURITY_EVENT_KINDS = [
  'trust_transition',
  'country_change',
  'new_device',
  'reauthenticated',
] as const;
export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number];

export const AUTH_CHALLENGE_KINDS = [
  'second_factor',
  'passkey_register',
  'passkey_authenticate',
  'totp_enrol',
  'step_up',
  'social_signup',
] as const;
export type AuthChallengeKind = (typeof AUTH_CHALLENGE_KINDS)[number];

export interface UsersTable {
  id: string;
  state: AccountState;
  email: string;
  email_normalized: string;
  email_verified_at: Date | null;
  date_of_birth: ColumnType<never, string, string>;
  locale: string | null;
  username: string | null;
  username_canonical: string | null;
  username_updated_at: Date | null;
  public_profile: Generated<boolean>;
  leaderboard_visible: Generated<boolean>;
  security_notifications: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export const AGE_ASSURANCE_STRENGTHS = ['self_declared', 'estimated', 'verified'] as const;
export type AgeAssuranceStrength = (typeof AGE_ASSURANCE_STRENGTHS)[number];

export interface AgeAssuranceResultsTable {
  id: string;
  user_id: string;
  provider: string;
  strength: AgeAssuranceStrength;
  trigger: string;
  vendor_reference: string | null;
  created_at: Generated<Date>;
}

export interface DateOfBirthChangesTable {
  id: string;
  user_id: string;
  actor_id: string;
  reason: string;
  previous_date_of_birth: ColumnType<never, string, string>;
  date_of_birth: ColumnType<never, string, string>;
  created_at: Generated<Date>;
}

export interface AuditLogTable {
  seq: number;
  event_id: string;
  occurred_at: Date;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  prev_hash: string;
  row_hash: string;
}

export const LEGAL_ACCEPTANCE_METHODS = ['signup', 'self', 'guardian'] as const;
export type LegalAcceptanceMethod = (typeof LEGAL_ACCEPTANCE_METHODS)[number];

export interface LegalVersionsTable {
  id: string;
  version: string;
  effective_at: Date;
  material: boolean;
  summary: string;
  body: string;
  body_hash: string;
  published_at: Date | null;
  created_at: Generated<Date>;
}

export interface LegalAcceptancesTable {
  user_id: string;
  document_id: string;
  version: string;
  accepted_at: Date;
  ip: string | null;
  method: LegalAcceptanceMethod;
}

export interface IdentitiesTable {
  id: string;
  user_id: string;
  type: string;
  subject: string | null;
  secret: string | null;
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
  ip: string | null;
  ip_subnet: string | null;
  country: string | null;
  last_country: string | null;
  tls_fingerprint: string | null;
  timezone: string | null;
  screen: string | null;
  client_fingerprint: string | null;
  device_key: string | null;
  trust_level: string;
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
  user_id: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
  used_at: Date | null;
}

export interface AuthFailuresTable {
  kind: AuthFailureKind;
  key: string;
  scope: AuthFailureScope;
  failures: number;
  updated_at: Date;
}

export interface AuthChallengesTable {
  id: string;
  token_hash: string;
  user_id: string | null;
  session_id: string | null;
  kind: AuthChallengeKind;
  payload: string;
  created_at: Generated<Date>;
  expires_at: Date;
  used_at: Date | null;
}

export interface RecoveryCodesTable {
  id: string;
  user_id: string;
  code_hash: string;
  created_at: Generated<Date>;
  used_at: Date | null;
}

export interface RolesTable {
  id: string;
  slug: string;
  name: string;
  description: string;
  builtin: boolean;
  created_at: Generated<Date>;
  updated_at: Date;
}

export interface RolePermissionsTable {
  role_id: string;
  grant: string;
}

export interface UserRolesTable {
  user_id: string;
  role_id: string;
}

export interface SessionSecurityEventsTable {
  id: string;
  user_id: string;
  session_id: string | null;
  kind: SecurityEventKind;
  trust_from: string | null;
  trust_to: string | null;
  country_from: string | null;
  country_to: string | null;
  notified: boolean;
  created_at: Generated<Date>;
}

export const FILTER_DECISIONS = ['allow', 'block'] as const;
export type FilterDecision = (typeof FILTER_DECISIONS)[number];

export const FILTER_LISTS = ['allow', 'extra_block'] as const;
export type FilterList = (typeof FILTER_LISTS)[number];

export interface FilterDecisionsTable {
  id: string;
  input_hash: string;
  raw_input: string | null;
  normalized: string;
  decision: FilterDecision;
  rule: string;
  matched_entry: string | null;
  context: string;
  created_at: Generated<Date>;
}

export interface FilterListEntriesTable {
  list: FilterList;
  word: string;
  created_at: Generated<Date>;
}

export interface UsernameHistoryTable {
  id: string;
  user_id: string;
  username: string;
  canonical: string;
  claimed_at: Date;
  released_at: Date | null;
}

export interface Database {
  users: UsersTable;
  identities: IdentitiesTable;
  sessions: SessionsTable;
  session_bindings: SessionBindingsTable;
  email_tokens: EmailTokensTable;
  auth_failures: AuthFailuresTable;
  auth_challenges: AuthChallengesTable;
  recovery_codes: RecoveryCodesTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  user_roles: UserRolesTable;
  session_security_events: SessionSecurityEventsTable;
  filter_decisions: FilterDecisionsTable;
  filter_list_entries: FilterListEntriesTable;
  username_history: UsernameHistoryTable;
  age_assurance_results: AgeAssuranceResultsTable;
  date_of_birth_changes: DateOfBirthChangesTable;
  audit_log: AuditLogTable;
  legal_versions: LegalVersionsTable;
  legal_acceptances: LegalAcceptancesTable;
}
