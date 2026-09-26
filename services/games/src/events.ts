import type { NewEvent } from '@qtiauth/bus';
import type { EntitlementSource } from '@qtiauth/config';
import { AUDIT_EVENTS, type EventActor, type GameTrustLevel, GAMES_EVENTS } from '@qtiauth/events';

export const ENTITLEMENT_TRUST: GameTrustLevel = 'game';

export interface EntitlementGrantedData {
  entitlement_id: string;
  user_id: string;
  game_id: string;
  product_id: string;
  source: EntitlementSource;
  trust: GameTrustLevel;
  expires_at: string | null;
}

export interface EntitlementRevokedData {
  entitlement_id: string;
  user_id: string;
  game_id: string;
  product_id: string;
  source: EntitlementSource;
  trust: GameTrustLevel;
  reason: string;
}

export interface AuditRecordedData {
  action: string;
  target_type: string;
  target_id: string;
}

export const SYSTEM_ACTOR: EventActor = { type: 'system', id: 'games' };

export function entitlementGrantedEvent(
  entitlementId: string,
  data: EntitlementGrantedData,
  actor: EventActor,
): NewEvent<EntitlementGrantedData> {
  return {
    type: GAMES_EVENTS.entitlementGranted,
    actor,
    subject: { type: 'entitlement', id: entitlementId },
    data,
  };
}

export function entitlementRevokedEvent(
  entitlementId: string,
  data: EntitlementRevokedData,
  actor: EventActor,
): NewEvent<EntitlementRevokedData> {
  return {
    type: GAMES_EVENTS.entitlementRevoked,
    actor,
    subject: { type: 'entitlement', id: entitlementId },
    data,
  };
}

export function auditRecordedEvent(
  actor: EventActor,
  data: AuditRecordedData,
): NewEvent<AuditRecordedData> {
  return {
    type: AUDIT_EVENTS.recorded,
    actor,
    subject: { type: data.target_type, id: data.target_id },
    data,
  };
}
