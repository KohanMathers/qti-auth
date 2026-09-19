import type { NewEvent } from '@qtiauth/bus';
import type { OidcClientType } from '@qtiauth/config';
import { OIDC_EVENTS, type EventActor } from '@qtiauth/events';

export interface AuthorizationGrantedData {
  client_id: string;
  client_type: OidcClientType;
  scopes: string[];
}

export interface RefreshReuseDetectedData {
  client_id: string;
  family_id: string;
}

export function authorizationGrantedEvent(
  userId: string,
  data: AuthorizationGrantedData,
  actor: EventActor,
): NewEvent<AuthorizationGrantedData> {
  return {
    type: OIDC_EVENTS.authorizationGranted,
    actor,
    subject: { type: 'user', id: userId },
    data,
  };
}

export function refreshReuseDetectedEvent(
  userId: string,
  data: RefreshReuseDetectedData,
): NewEvent<RefreshReuseDetectedData> {
  return {
    type: OIDC_EVENTS.refreshReuseDetected,
    actor: { type: 'system', id: 'oidc' },
    subject: { type: 'user', id: userId },
    data,
  };
}

export interface ClientCreatedData {
  client_id: string;
  client_type: OidcClientType;
  owner_user_id: string;
}

export function clientCreatedEvent(
  clientId: string,
  actor: EventActor,
  data: ClientCreatedData,
): NewEvent<ClientCreatedData> {
  return {
    type: OIDC_EVENTS.clientCreated,
    actor,
    subject: { type: 'oauth_client', id: clientId },
    data,
  };
}
