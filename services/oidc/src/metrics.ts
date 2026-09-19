import type { OidcClientType } from '@qtiauth/config';
import type { Metrics } from '@qtiauth/observability';

export type AuthorizationResult = 'granted' | 'denied' | 'error';
export type TokenGrantType = 'authorization_code' | 'refresh_token';
export type TokenGrantResult = 'success' | 'error';

export interface OidcMetrics {
  authorization: (clientType: OidcClientType, result: AuthorizationResult) => void;
  tokenGrant: (grantType: TokenGrantType, result: TokenGrantResult) => void;
  refreshReuse: () => void;
  introspection: (active: boolean) => void;
  keyRotated: () => void;
  keyLoaded: (createdAt: number) => void;
}

const created = new WeakMap<Metrics, OidcMetrics>();

export function oidcMetrics(metrics: Metrics): OidcMetrics {
  let oidc = created.get(metrics);
  if (!oidc) {
    oidc = prometheusOidcMetrics(metrics);
    created.set(metrics, oidc);
  }
  return oidc;
}

export function prometheusOidcMetrics(metrics: Metrics): OidcMetrics {
  const authorizations = metrics.counter({
    name: 'qtiauth_oidc_authorizations_total',
    help: 'Authorization results, by client type and result.',
    labelNames: ['client_type', 'result'],
  });
  const grants = metrics.counter({
    name: 'qtiauth_oidc_token_grants_total',
    help: 'Token endpoint grants, by grant type and result.',
    labelNames: ['grant_type', 'result'],
  });
  const reuse = metrics.counter({
    name: 'qtiauth_oidc_refresh_reuse_total',
    help: 'Refresh tokens presented after they had already been rotated. The family is revoked.',
  });
  const introspections = metrics.counter({
    name: 'qtiauth_oidc_introspections_total',
    help: 'Token introspections, by whether the token was active.',
    labelNames: ['active'],
  });
  const rotations = metrics.counter({
    name: 'qtiauth_oidc_key_rotations_total',
    help: 'OIDC signing keys rotated by this replica.',
  });
  const keyCreated = metrics.gauge({
    name: 'qtiauth_oidc_key_created_timestamp_seconds',
    help: 'When the key currently signing ID and access tokens was created, as a Unix timestamp.',
  });
  return {
    authorization: (clientType, result) => {
      authorizations.inc({ client_type: clientType, result });
    },
    tokenGrant: (grantType, result) => {
      grants.inc({ grant_type: grantType, result });
    },
    refreshReuse: () => {
      reuse.inc();
    },
    introspection: (active) => {
      introspections.inc({ active: active ? 'true' : 'false' });
    },
    keyRotated: () => {
      rotations.inc();
    },
    keyLoaded: (createdAt) => {
      keyCreated.set(createdAt / 1000);
    },
  };
}
