import type { NewEvent } from '@qtiauth/bus';
import type { AccountState, AgeBand } from '@qtiauth/service-kit';

import type { RevocationReason } from './database.ts';

export const USER_CREATED_EVENT = 'qtiauth.identity.user.created.v1';
export const SESSION_CREATED_EVENT = 'qtiauth.identity.session.created.v1';
export const SESSION_REVOKED_EVENT = 'qtiauth.identity.session.revoked.v1';

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

export function userCreatedEvent(userId: string, data: UserCreatedData): NewEvent<UserCreatedData> {
  return {
    type: USER_CREATED_EVENT,
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
    type: SESSION_CREATED_EVENT,
    actor: { type: 'user', id: data.user_id },
    subject: { type: 'session', id: sessionId },
    data,
  };
}

export function sessionRevokedEvent(data: SessionRevokedData): NewEvent<SessionRevokedData> {
  return {
    type: SESSION_REVOKED_EVENT,
    actor: { type: 'user', id: data.user_id },
    subject: { type: 'session', id: data.session_id },
    data,
  };
}
