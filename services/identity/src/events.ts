import type { NewEvent } from '@qtiauth/bus';
import { AUDIT_EVENTS, IDENTITY_EVENTS, type EventActor } from '@qtiauth/events';
import type { AccountState, AgeBand } from '@qtiauth/service-kit';

import type { RevocationReason } from './database.ts';

export interface UserCreatedData {
  signup_method: string;
  account_state: AccountState;
  age_band: AgeBand;
}

export interface SessionCreatedData {
  user_id: string;
  auth_method: string;
  amr: string[];
  acr: string;
}

export interface SessionRevokedData {
  session_id: string;
  user_id: string;
  reason: RevocationReason;
}

export interface SessionFlaggedData {
  session_id: string;
  user_id: string;
  reason: 'country_change' | 'trust';
  trust_level: string;
  acr: string;
}

export interface UserUpdatedData {
  fields: string[];
}

export interface UserAgeBandChangedData {
  previous_age_band: AgeBand;
  age_band: AgeBand;
}

export interface AuditRecordedData {
  action: string;
  target_type: string;
  target_id: string;
}

export function userCreatedEvent(userId: string, data: UserCreatedData): NewEvent<UserCreatedData> {
  return {
    type: IDENTITY_EVENTS.userCreated,
    actor: { type: 'user', id: userId },
    subject: { type: 'user', id: userId },
    data,
  };
}

export function sessionCreatedEvent(
  sessionId: string,
  data: SessionCreatedData,
): NewEvent<SessionCreatedData> {
  return {
    type: IDENTITY_EVENTS.sessionCreated,
    actor: { type: 'user', id: data.user_id },
    subject: { type: 'session', id: sessionId },
    data,
  };
}

export function sessionRevokedEvent(data: SessionRevokedData): NewEvent<SessionRevokedData> {
  return {
    type: IDENTITY_EVENTS.sessionRevoked,
    actor: { type: 'user', id: data.user_id },
    subject: { type: 'session', id: data.session_id },
    data,
  };
}

export function sessionFlaggedEvent(data: SessionFlaggedData): NewEvent<SessionFlaggedData> {
  return {
    type: IDENTITY_EVENTS.sessionFlagged,
    actor: { type: 'user', id: data.user_id },
    subject: { type: 'session', id: data.session_id },
    data,
  };
}

export function userUpdatedEvent(
  userId: string,
  data: UserUpdatedData,
  actor: EventActor = { type: 'user', id: userId },
): NewEvent<UserUpdatedData> {
  return {
    type: IDENTITY_EVENTS.userUpdated,
    actor,
    subject: { type: 'user', id: userId },
    data,
  };
}

export function userAgeBandChangedEvent(
  userId: string,
  data: UserAgeBandChangedData,
  actor: EventActor = { type: 'system', id: 'identity' },
): NewEvent<UserAgeBandChangedData> {
  return {
    type: IDENTITY_EVENTS.userAgeBandChanged,
    actor,
    subject: { type: 'user', id: userId },
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
