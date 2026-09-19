import type { OidcClientType } from '@qtiauth/config';
import type { Metrics } from '@qtiauth/observability';

export type AuthorizationResult = 'granted' | 'denied' | 'error';
export type TokenGrantType =
  'authorization_code' | 'refresh_token' | 'client_credentials' | 'device_code';
export type TokenGrantResult = 'success' | 'error';

export interface OidcMetrics {
  authorization: (clientType: OidcClientType, result: AuthorizationResult) => void;
  tokenGrant: (grantType: TokenGrantType, result: TokenGrantResult) => void;
  refreshReuse: () => void;
  deviceApproval: (result: 'granted' | 'denied') => void;
  introspection: (active: boolean) => void;
  logoutDelivery: (status: 'retrying' | 'sent' | 'failed') => void;
  logoutAttempt: (outcome: 'ok' | 'error', seconds: number) => void;
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
  const deviceApprovals = metrics.counter({
    name: 'qtiauth_oidc_device_approvals_total',
    help: 'Device-flow approvals, by whether the user allowed or denied the request.',
    labelNames: ['result'],
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
  const logoutDeliveries = metrics.counter({
    name: 'qtiauth_oidc_logout_deliveries_total',
    help: 'Back-channel logout deliveries, by status.',
    labelNames: ['status'],
  });
  const logoutAttempts = metrics.histogram({
    name: 'qtiauth_oidc_logout_delivery_duration_seconds',
    help: 'Time spent POSTing a back-channel logout token, by outcome.',
    labelNames: ['outcome'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
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
    deviceApproval: (result) => {
      deviceApprovals.inc({ result });
    },
    introspection: (active) => {
      introspections.inc({ active: active ? 'true' : 'false' });
    },
    logoutDelivery: (status) => {
      logoutDeliveries.inc({ status });
    },
    logoutAttempt: (outcome, seconds) => {
      logoutAttempts.observe({ outcome }, seconds);
    },
    keyRotated: () => {
      rotations.inc();
    },
    keyLoaded: (createdAt) => {
      keyCreated.set(createdAt / 1000);
    },
  };
}
