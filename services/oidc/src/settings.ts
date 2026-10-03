import { type SURFACES } from '@qtiauth/config';
import { parseEncryptionKey } from '@qtiauth/keys';

import type { Context, OidcConfig } from './service.ts';

export const AUTHORIZE_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/oauth/token';
export const USERINFO_PATH = '/oauth/userinfo';
export const REVOKE_PATH = '/oauth/revoke';
export const INTROSPECT_PATH = '/oauth/introspect';
export const DEVICE_AUTHORIZATION_PATH = '/oauth/device_authorization';
export const PAR_PATH = '/oauth/par';
export const DISCOVERY_PATH = '/.well-known/openid-configuration';
export const JWKS_PATH = '/.well-known/jwks.json';
export const AUTHORIZED_PATH = '/api/v1/oauth/authorized';
export const CLIENT_PATH = '/api/v1/oauth/client';
export const CLIENTS_PATH = '/api/v1/oauth/clients';
export const CONSENT_PATH = '/api/v1/oauth/consent';
export const DEVICE_PATH = '/api/v1/oauth/device';
export const DEVICE_VERIFY_PATH = '/api/v1/oauth/device/verify';
export const CONSENT_PAGE = '/consent';
export const DEVICE_PAGE = '/device';
export const ADMIN_CLIENTS_PATH = '/api/v1/admin/oauth/clients';

export class OidcConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcConfigError';
  }
}

export function surfaceOrigin(
  config: Pick<OidcConfig, 'surfaces'>,
  name: (typeof SURFACES)[number],
): string | undefined {
  const surface = config.surfaces[name];
  return surface.origins?.[0] ?? (surface.hosts[0] && `https://${surface.hosts[0]}`);
}

export function issuerUrl(config: Pick<OidcConfig, 'oidc' | 'surfaces'>): string {
  if (config.oidc.issuer !== null) return config.oidc.issuer.replace(/\/+$/, '');
  const origin = surfaceOrigin(config, 'api') ?? surfaceOrigin(config, 'account');
  if (!origin) {
    throw new OidcConfigError(
      'oidc.issuer is required when the api surface has no origin or host, so discovery can name this provider',
    );
  }
  return origin;
}

export function resourceAudience(config: Pick<OidcConfig, 'oidc' | 'surfaces'>): string {
  return config.oidc.resource ?? issuerUrl(config);
}

export function encryptionKey(config: Pick<OidcConfig, 'oidc'>): Buffer {
  return parseEncryptionKey(config.oidc.signing.encryption_key, 'oidc.signing.encryption_key');
}

export function requireIssuer(ctx: Context): string {
  return issuerUrl(ctx.config);
}
