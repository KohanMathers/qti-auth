export const SESSION_TOKEN_HEADER = 'X-QTIAuth-Session-Token';
export const SESSION_EXPIRES_HEADER = 'X-QTIAuth-Session-Expires';
export const SESSION_CLEAR_HEADER = 'X-QTIAuth-Session-Clear';
export const REVOKED_SESSIONS_HEADER = 'X-QTIAuth-Revoked-Sessions';
export const SESSION_COUNTRY_HEADER = 'X-QTIAuth-Country';
export const SESSION_TIMEZONE_HEADER = 'X-QTIAuth-Timezone';
export const SESSION_SCREEN_HEADER = 'X-QTIAuth-Screen';
export const SESSION_CLIENT_FINGERPRINT_HEADER = 'X-QTIAuth-Client-Fingerprint';
export const FLOW_BINDING_HEADER = 'X-QTIAuth-Flow-Binding';
export const FAMILY_TOKEN_HEADER = 'X-QTIAuth-Family-Token';
export const FAMILY_EXPIRES_HEADER = 'X-QTIAuth-Family-Expires';
export const FAMILY_CLEAR_HEADER = 'X-QTIAuth-Family-Clear';

export const SESSION_RESPONSE_HEADERS = [
  SESSION_TOKEN_HEADER,
  SESSION_EXPIRES_HEADER,
  SESSION_CLEAR_HEADER,
  REVOKED_SESSIONS_HEADER,
  FLOW_BINDING_HEADER,
  FAMILY_TOKEN_HEADER,
  FAMILY_EXPIRES_HEADER,
  FAMILY_CLEAR_HEADER,
] as const;
