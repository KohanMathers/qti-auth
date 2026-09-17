import type {
  DeclaredPermission,
  HttpMethod,
  ManifestRoute,
  RouteManifest,
} from '@qtiauth/service-kit';

import { ownsModule, type Surface, type SurfaceName } from './surfaces.ts';

export interface TableRoute {
  service: string;
  route: ManifestRoute;
  permissions: ReadonlyMap<string, DeclaredPermission>;
}

export interface Mount {
  surface: SurfaceName;
  method: HttpMethod;
  path: string;
  prefix: string;
  segments: readonly string[];
  route: TableRoute;
}

export type RouteProblem =
  | {
      code: 'ROUTE_CONFLICT';
      surface: SurfaceName;
      method: HttpMethod;
      path: string;
      services: string[];
    }
  | {
      code: 'UNKNOWN_RATE_LIMIT_POLICY';
      service: string;
      method: HttpMethod;
      path: string;
      policy: string;
    };

export interface RouteMatch {
  mount: Mount;
  params: Record<string, string>;
}

export type RouteLookup =
  | { status: 'found'; match: RouteMatch }
  | { status: 'method_not_allowed'; allowed: HttpMethod[] }
  | { status: 'not_found' };

export interface RouteTable {
  routes: readonly TableRoute[];
  mounts: readonly Mount[];
  problems: readonly RouteProblem[];
  lookup: (surface: SurfaceName, method: string, path: string) => RouteLookup;
}

export interface RouteTableOptions {
  surfaces: readonly Surface[];
  manifests: readonly RouteManifest[];
  rateLimits: ReadonlySet<string>;
}

const API_PREFIX = '/api';
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;

export function mountPath(surface: SurfaceName, path: string): { path: string; prefix: string } {
  if (surface === 'api' && (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`))) {
    return { path: path.slice(API_PREFIX.length) || '/', prefix: API_PREFIX };
  }
  return { path, prefix: '' };
}

function segmentsOf(path: string): string[] {
  return path.split('/').slice(1);
}

function shape(segments: readonly string[]): string {
  return segments.map((segment) => (segment.startsWith(':') ? ':' : segment)).join('/');
}

function matchSegments(
  pattern: readonly string[],
  segments: readonly string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of pattern.entries()) {
    const segment = segments[i] ?? '';
    if (part.startsWith(':')) {
      if (segment === '') return null;
      try {
        params[part.slice(1)] = decodeURIComponent(segment);
      } catch {
        return null;
      }
    } else if (part !== segment) {
      return null;
    }
  }
  return params;
}

function moreSpecific(a: Mount, b: Mount): boolean {
  for (const [i, part] of a.segments.entries()) {
    const other = b.segments[i] ?? '';
    const aParam = part.startsWith(':');
    if (aParam !== other.startsWith(':')) return !aParam;
  }
  return false;
}

export function buildRouteTable(options: RouteTableOptions): RouteTable {
  const problems: RouteProblem[] = [];
  const routes: TableRoute[] = [];

  for (const manifest of [...options.manifests].sort((a, b) =>
    a.service.localeCompare(b.service),
  )) {
    const permissions = new Map(manifest.permissions.map((p) => [p.name, p]));
    for (const route of manifest.routes) {
      if (!options.rateLimits.has(route.rate_limit)) {
        problems.push({
          code: 'UNKNOWN_RATE_LIMIT_POLICY',
          service: manifest.service,
          method: route.method,
          path: route.path,
          policy: route.rate_limit,
        });
        continue;
      }
      routes.push({ service: manifest.service, route, permissions });
    }
  }

  const byKey = new Map<string, Mount[]>();
  for (const surface of options.surfaces) {
    for (const table of routes) {
      if (!ownsModule(surface, table.route.module)) continue;
      const mounted = mountPath(surface.name, table.route.path);
      const segments = segmentsOf(mounted.path);
      const mount: Mount = {
        surface: surface.name,
        method: table.route.method,
        path: mounted.path,
        prefix: mounted.prefix,
        segments,
        route: table,
      };
      const key = `${surface.name} ${mount.method} ${shape(segments)}`;
      byKey.set(key, [...(byKey.get(key) ?? []), mount]);
    }
  }

  const mounts: Mount[] = [];
  for (const group of byKey.values()) {
    const [first] = group;
    if (!first) continue;
    if (group.length === 1) {
      mounts.push(first);
      continue;
    }
    problems.push({
      code: 'ROUTE_CONFLICT',
      surface: first.surface,
      method: first.method,
      path: first.path,
      services: group.map((mount) => mount.route.service),
    });
  }

  const bySurface = new Map<SurfaceName, Mount[]>();
  for (const mount of mounts) {
    bySurface.set(mount.surface, [...(bySurface.get(mount.surface) ?? []), mount]);
  }

  return {
    routes,
    mounts,
    problems,
    lookup: (surface, method, path) => {
      if (ENCODED_SEPARATOR.test(path)) return { status: 'not_found' };
      const segments = segmentsOf(path);
      let best: RouteMatch | undefined;
      const allowed = new Set<HttpMethod>();
      for (const mount of bySurface.get(surface) ?? []) {
        const params = matchSegments(mount.segments, segments);
        if (params === null) continue;
        if (mount.method !== method) {
          allowed.add(mount.method);
          continue;
        }
        if (!best || moreSpecific(mount, best.mount)) best = { mount, params };
      }
      if (best) return { status: 'found', match: best };
      if (allowed.size > 0) return { status: 'method_not_allowed', allowed: [...allowed].sort() };
      return { status: 'not_found' };
    },
  };
}
