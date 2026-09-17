export const SESSION_TOKEN_HEADER = 'X-QTIAuth-Session-Token';
export const SESSION_EXPIRES_HEADER = 'X-QTIAuth-Session-Expires';
export const SESSION_CLEAR_HEADER = 'X-QTIAuth-Session-Clear';
export const REVOKED_SESSIONS_HEADER = 'X-QTIAuth-Revoked-Sessions';

export const SESSION_RESPONSE_HEADERS = [
  SESSION_TOKEN_HEADER,
  SESSION_EXPIRES_HEADER,
  SESSION_CLEAR_HEADER,
  REVOKED_SESSIONS_HEADER,
] as const;
