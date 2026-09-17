import { MODULES, type QtiauthConfig, SURFACES } from '@qtiauth/config';
import type { RouteModule } from '@qtiauth/service-kit';
import { getDomain } from 'tldts';

export const BIND_PATH = '/auth/bind';
export const LOGIN_PATH = '/auth/login';

export type SurfaceName = (typeof SURFACES)[number];
export type Module = (typeof MODULES)[number];

export interface Surface {
  name: SurfaceName;
  hosts: readonly string[];
  ports: readonly number[];
  basePath: string;
  modules: ReadonlySet<Module>;
  origins: readonly string[];
}

export interface SurfaceMatch {
  surface: Surface;
  path: string;
}

export interface SurfacePair {
  surfaces: [SurfaceName, SurfaceName];
  same_site: boolean;
}

export const DEFAULT_MODULES: Record<SurfaceName, readonly Module[]> = {
  account: ['identity', 'oidc', 'games', 'safety', 'admin'],
  support: ['support'],
  api: MODULES,
};

export function resolveSurfaces(config: Pick<QtiauthConfig, 'surfaces'>): Surface[] {
  return SURFACES.map((name) => {
    const surface = config.surfaces[name];
    return {
      name,
      hosts: surface.hosts.map((host) => host.toLowerCase()),
      ports: surface.ports,
      basePath: surface.base_path,
      modules: new Set(surface.modules ?? DEFAULT_MODULES[name]),
      origins: surface.origins ?? surface.hosts.map((host) => `https://${host.toLowerCase()}`),
    };
  });
}

export function ownsModule(surface: Surface, module: RouteModule): boolean {
  return module === 'core' || surface.modules.has(module);
}

export function listenPorts(surfaces: readonly Surface[], hostPort: number): number[] {
  const ports = new Set<number>();
  for (const surface of surfaces) {
    if (surface.ports.length === 0) ports.add(hostPort);
    for (const port of surface.ports) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

export function requestHost(hostHeader: string | null): string | null {
  if (hostHeader === null) return null;
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim());
  if (!match?.[1]) return null;
  return match[1].toLowerCase().replace(/\.$/, '');
}

function underBase(basePath: string, path: string): boolean {
  return basePath === '/' || path === basePath || path.startsWith(`${basePath}/`);
}

export function matchSurface(
  surfaces: readonly Surface[],
  host: string | null,
  localPort: number,
  path: string,
): SurfaceMatch | null {
  let best: Surface | undefined;
  for (const surface of surfaces) {
    if (surface.hosts.length > 0 && (host === null || !surface.hosts.includes(host))) continue;
    if (surface.ports.length > 0 && !surface.ports.includes(localPort)) continue;
    if (!underBase(surface.basePath, path)) continue;
    if (!best || surface.basePath.length > best.basePath.length) best = surface;
  }
  if (!best) return null;
  const relative = best.basePath === '/' ? path : path.slice(best.basePath.length);
  return { surface: best, path: relative === '' ? '/' : relative };
}

function site(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname}`;
}

export function isSameSite(a: string, b: string): boolean {
  return site(a) === site(b);
}

export function needsSessionBinding(
  cookies: { domain: string | null },
  host: string | null,
  account: Surface,
): boolean {
  if (host === null || host === '') return false;
  if (cookies.domain !== null) {
    return host !== cookies.domain && !host.endsWith(`.${cookies.domain}`);
  }
  if (account.hosts.length === 0) return false;
  return !account.hosts.includes(host);
}

export function surfacePublicUrl(surface: Surface, path: string): string | null {
  const origin = surface.origins[0];
  if (origin === undefined) return null;
  const prefix = surface.basePath === '/' ? '' : surface.basePath;
  return new URL(`${prefix}${path}`, origin).toString();
}

export function bindStartUrl(
  account: Surface,
  target: SurfaceName,
  returnPath: string,
): string | null {
  const url = surfacePublicUrl(account, BIND_PATH);
  if (url === null) return null;
  const parsed = new URL(url);
  parsed.searchParams.set('target', target);
  parsed.searchParams.set('return', returnPath);
  return parsed.toString();
}

export function isTopLevelNavigation(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const mode = request.headers.get('sec-fetch-mode');
  if (mode !== null) return mode === 'navigate';
  return /\btext\/html\b/.test(request.headers.get('accept') ?? '');
}

export function surfacePairs(surfaces: readonly Surface[]): SurfacePair[] {
  const pairs: SurfacePair[] = [];
  for (const [i, first] of surfaces.entries()) {
    for (const second of surfaces.slice(i + 1)) {
      const origins = [...first.origins, ...second.origins];
      pairs.push({
        surfaces: [first.name, second.name],
        same_site:
          first.origins.length > 0 &&
          second.origins.length > 0 &&
          origins.every((origin) => isSameSite(origin, origins[0] ?? origin)),
      });
    }
  }
  return pairs;
}
