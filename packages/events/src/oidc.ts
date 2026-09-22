export const OIDC_EVENTS = {
  authorizationGranted: 'qtiauth.oidc.authorization.granted.v1',
  authorizationGuardianRequested: 'qtiauth.oidc.authorization.guardian_requested.v1',
  refreshReuseDetected: 'qtiauth.oidc.refresh.reuse_detected.v1',
  clientAuthorized: 'qtiauth.oidc.client.authorized.v1',
  clientCreated: 'qtiauth.oidc.client.created.v1',
} as const;

export type OidcEventType = (typeof OIDC_EVENTS)[keyof typeof OIDC_EVENTS];
