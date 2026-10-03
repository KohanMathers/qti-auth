import type { QtiauthConfig } from '@qtiauth/config';

type Surface = QtiauthConfig['surfaces'][keyof QtiauthConfig['surfaces']];

function originOf(surface: Surface): string | undefined {
  return surface.origins?.[0] ?? (surface.hosts[0] ? `https://${surface.hosts[0]}` : undefined);
}

export interface AdminOrigins {
  account: string | undefined;
  support: string | undefined;
}

export interface AdminLink {
  surface: 'account' | 'support';
  path: string;
}

function withBase(surface: Surface): string | undefined {
  const origin = originOf(surface);
  if (origin === undefined) return undefined;
  return surface.base_path === '/' ? origin : `${origin}${surface.base_path}`;
}

export function adminOrigins(surfaces: QtiauthConfig['surfaces']): AdminOrigins {
  return { account: withBase(surfaces.account), support: withBase(surfaces.support) };
}

export function adminUrl(origins: AdminOrigins, link: AdminLink): string | undefined {
  const base = link.surface === 'support' ? origins.support : origins.account;
  return base === undefined ? undefined : new URL(`${base}${link.path}`).toString();
}
