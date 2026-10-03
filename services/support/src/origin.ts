import type { QtiauthConfig } from '@qtiauth/config';

function originOf(
  surface: QtiauthConfig['surfaces'][keyof QtiauthConfig['surfaces']],
): string | undefined {
  return surface.origins?.[0] ?? (surface.hosts[0] ? `https://${surface.hosts[0]}` : undefined);
}

function withBase(origin: string, basePath: string, path: string): string {
  const base = basePath === '/' ? '' : basePath;
  return new URL(`${base}${path}`, origin).toString();
}

export function ticketUrl(
  surfaces: QtiauthConfig['surfaces'],
  ticketId: string,
): string | undefined {
  const origin = originOf(surfaces.support);
  if (origin === undefined) return undefined;
  return withBase(origin, surfaces.support.base_path, `/tickets/${encodeURIComponent(ticketId)}`);
}

export function guestTicketUrl(
  surfaces: QtiauthConfig['surfaces'],
  token: string,
): string | undefined {
  const origin = originOf(surfaces.support);
  if (origin === undefined) return undefined;
  const url = new URL(withBase(origin, surfaces.support.base_path, '/guest/view'));
  url.searchParams.set('token', token);
  return url.toString();
}

export function staffTicketUrl(
  surfaces: QtiauthConfig['surfaces'],
  ticketId: string,
): string | undefined {
  const origin = originOf(surfaces.support);
  if (origin === undefined) return undefined;
  return withBase(
    origin,
    surfaces.support.base_path,
    `/staff/tickets/${encodeURIComponent(ticketId)}`,
  );
}
