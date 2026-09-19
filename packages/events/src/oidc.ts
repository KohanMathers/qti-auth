export const OIDC_EVENTS = {
  authorizationGranted: 'qtiauth.oidc.authorization.granted.v1',
  refreshReuseDetected: 'qtiauth.oidc.refresh.reuse_detected.v1',
} as const;

export type OidcEventType = (typeof OIDC_EVENTS)[keyof typeof OIDC_EVENTS];
