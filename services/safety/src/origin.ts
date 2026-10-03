import type { QtiauthConfig } from '@qtiauth/config';

export function accountOrigin(surfaces: QtiauthConfig['surfaces']): string | undefined {
  const surface = surfaces.account;
  return surface.origins?.[0] ?? (surface.hosts[0] ? `https://${surface.hosts[0]}` : undefined);
}

export function appealUrl(
  surfaces: QtiauthConfig['surfaces'],
  actionId: string,
): string | undefined {
  const surface = surfaces.support;
  const origin =
    surface.origins?.[0] ?? (surface.hosts[0] ? `https://${surface.hosts[0]}` : undefined);
  if (origin === undefined) return undefined;
  const base = surface.base_path === '/' ? '' : surface.base_path;
  const url = new URL(`${base}/appeals/new`, origin);
  url.searchParams.set('action_id', actionId);
  return url.toString();
}

export function cseaCaseUrl(
  surfaces: QtiauthConfig['surfaces'],
  caseId: string,
): string | undefined {
  const origin = accountOrigin(surfaces);
  if (origin === undefined) return undefined;
  return new URL(`/admin/csea/${encodeURIComponent(caseId)}`, origin).toString();
}
