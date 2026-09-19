import type { OidcClientType } from '@qtiauth/config';
import type { Generated } from 'kysely';

export interface ClientsTable {
  id: string;
  client_id: string;
  name: string;
  description: string;
  type: OidcClientType;
  secret_hash: string | null;
  first_party: boolean;
  verified: boolean;
  redirect_uris: string[];
  allowed_scopes: string[] | null;
  require_par: boolean;
  backchannel_logout_uri: string | null;
  backchannel_logout_session_required: boolean;
  suspended_at: Date | null;
  owner_user_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ConsentsTable {
  user_id: string;
  client_id: string;
  scopes: string[];
  granted_at: Date;
}

export interface AuthorizationRequestsTable {
  id: string;
  client_id: string;
  user_id: string;
  session_id: string;
  redirect_uri: string;
  scopes: string[];
  state: string | null;
  nonce: string | null;
  code_challenge: string;
  auth_time: Date;
  amr: string[];
  acr: string;
  expires_at: Date;
  completed_at: Date | null;
  created_at: Generated<Date>;
}

export interface AuthorizationCodesTable {
  id: string;
  code_hash: string;
  client_id: string;
  user_id: string;
  session_id: string;
  redirect_uri: string;
  scopes: string[];
  nonce: string | null;
  code_challenge: string;
  auth_time: Date;
  amr: string[];
  acr: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Generated<Date>;
}

export interface RefreshTokensTable {
  id: string;
  token_hash: string;
  family_id: string;
  client_id: string;
  user_id: string;
  session_id: string | null;
  scopes: string[];
  expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  created_at: Generated<Date>;
}

export interface AccessTokensTable {
  id: string;
  client_id: string;
  user_id: string | null;
  session_id: string | null;
  scopes: string[];
  amr: string[];
  acr: string;
  expires_at: Date;
  revoked_at: Date | null;
  refresh_id: string | null;
  created_at: Generated<Date>;
}

export type DeviceAuthorizationStatus = 'pending' | 'authorized' | 'denied';

export interface PushedAuthorizationRequestsTable {
  id: string;
  request_uri_hash: string;
  client_id: string;
  redirect_uri: string;
  scopes: string[];
  state: string | null;
  nonce: string | null;
  code_challenge: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Generated<Date>;
}

export type LogoutCause = 'session' | 'lock' | 'ban' | 'deletion';
export type LogoutDeliveryStatus = 'retrying' | 'sent' | 'failed';

export interface LogoutDeliveriesTable {
  id: string;
  client_id: string;
  user_id: string;
  session_id: string;
  uri: string;
  cause: LogoutCause;
  status: LogoutDeliveryStatus;
  attempts: number;
  next_attempt_at: Date | null;
  queued_at: Date;
  sent_at: Date | null;
  last_error: string | null;
  response_status: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DeviceAuthorizationsTable {
  id: string;
  device_code_hash: string;
  user_code_hash: string;
  client_id: string;
  scopes: string[];
  interval_ms: number;
  last_polled_at: Date | null;
  status: DeviceAuthorizationStatus;
  user_id: string | null;
  session_id: string | null;
  auth_time: Date | null;
  amr: string[] | null;
  acr: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Generated<Date>;
}

export interface Database {
  clients: ClientsTable;
  consents: ConsentsTable;
  authorization_requests: AuthorizationRequestsTable;
  authorization_codes: AuthorizationCodesTable;
  refresh_tokens: RefreshTokensTable;
  access_tokens: AccessTokensTable;
  pushed_authorization_requests: PushedAuthorizationRequestsTable;
  device_authorizations: DeviceAuthorizationsTable;
  logout_deliveries: LogoutDeliveriesTable;
}
