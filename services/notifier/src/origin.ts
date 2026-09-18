import type { QtiauthConfig } from '@qtiauth/config';

export function accountOrigin(surfaces: QtiauthConfig['surfaces']): string | undefined {
  const surface = surfaces.account;
  return surface.origins?.[0] ?? (surface.hosts[0] ? `https://${surface.hosts[0]}` : undefined);
}
