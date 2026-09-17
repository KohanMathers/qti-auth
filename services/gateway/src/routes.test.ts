import { sections } from '@qtiauth/config';
import type { ManifestRoute, RouteManifest } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { buildRouteTable, mountPath } from './routes.ts';
import { resolveSurfaces } from './surfaces.ts';

const surfaces = resolveSurfaces({
  surfaces: sections.surfaces.parse({
    account: { hosts: ['me.example.com'], base_path: '/' },
    support: { hosts: ['me.example.com'], base_path: '/support' },
    api: { hosts: ['me.example.com'], base_path: '/api' },
  }),
});

function route(overrides: Partial<ManifestRoute>): ManifestRoute {
  return {
    method: 'GET',
    path: '/api/v1/me',
    module: 'core',
    auth: 'session',
    permissions: [],
    scopes: [],
    allow_account_states: ['active'],
    allow_pending_legal: false,
    allow_pending_parental_consent: false,
    allow_pending_2fa_enrolment: false,
    allow_aal0: false,
    rate_limit: 'global',
    step_up: false,
    ...overrides,
  };
}

function manifest(service: string, routes: ManifestRoute[]): RouteManifest {
  return { service, version: '1.0.0', routes, permissions: [] };
}

const rateLimits = new Set(['global', 'ticket_create']);

describe('mountPath', () => {
  it('mounts API routes at the root of the api surface', () => {
    expect(mountPath('api', '/api/v1/me')).toEqual({ path: '/v1/me', prefix: '/api' });
    expect(mountPath('api', '/oauth/token')).toEqual({ path: '/oauth/token', prefix: '' });
    expect(mountPath('account', '/api/v1/me')).toEqual({ path: '/api/v1/me', prefix: '' });
  });
});

describe('buildRouteTable', () => {
  const table = buildRouteTable({
    surfaces,
    rateLimits,
    manifests: [
      manifest('identity', [
        route({}),
        route({ path: '/api/v1/sessions/:session_id', method: 'DELETE' }),
        route({ path: '/api/v1/sessions/current', method: 'DELETE' }),
        route({ path: '/api/v1/admin/users', module: 'admin' }),
      ]),
      manifest('support', [
        route({
          path: '/api/v1/support/tickets',
          method: 'POST',
          module: 'support',
          rate_limit: 'ticket_create',
        }),
      ]),
    ],
  });

  it('mounts core routes on every surface and module routes on their owners', () => {
    const mounted = table.mounts.map((m) => `${m.surface} ${m.method} ${m.path}`);
    expect(mounted).toEqual(
      expect.arrayContaining([
        'account GET /api/v1/me',
        'support GET /api/v1/me',
        'api GET /v1/me',
        'account GET /api/v1/admin/users',
        'api GET /v1/admin/users',
        'support POST /api/v1/support/tickets',
        'api POST /v1/support/tickets',
      ]),
    );
    expect(mounted).not.toContain('support GET /api/v1/admin/users');
    expect(mounted).not.toContain('account POST /api/v1/support/tickets');
  });

  it('matches params and prefers static segments', () => {
    const found = table.lookup('account', 'DELETE', '/api/v1/sessions/abc%20def');
    expect(found).toMatchObject({
      status: 'found',
      match: { params: { session_id: 'abc def' } },
    });
    expect(table.lookup('account', 'DELETE', '/api/v1/sessions/current')).toMatchObject({
      status: 'found',
      match: { params: {}, mount: { path: '/api/v1/sessions/current' } },
    });
  });

  it('distinguishes wrong methods from missing routes', () => {
    expect(table.lookup('account', 'POST', '/api/v1/me')).toEqual({
      status: 'method_not_allowed',
      allowed: ['GET'],
    });
    expect(table.lookup('account', 'GET', '/api/v1/you')).toEqual({ status: 'not_found' });
    expect(table.lookup('account', 'GET', '/api/v1/me/')).toEqual({ status: 'not_found' });
    expect(table.lookup('account', 'DELETE', '/api/v1/sessions/a%2Fb')).toEqual({
      status: 'not_found',
    });
    expect(table.lookup('account', 'DELETE', '/api/v1/sessions/%E0%A4%A')).toEqual({
      status: 'not_found',
    });
  });

  it('drops conflicting routes and routes with unknown rate limits', () => {
    const conflicted = buildRouteTable({
      surfaces,
      rateLimits,
      manifests: [
        manifest('identity', [route({ path: '/api/v1/users/:user_id' })]),
        manifest('games', [
          route({ path: '/api/v1/users/:id', module: 'games' }),
          route({ path: '/api/v1/games', module: 'games', rate_limit: 'nope' }),
        ]),
      ],
    });
    expect(conflicted.problems).toEqual([
      {
        code: 'UNKNOWN_RATE_LIMIT_POLICY',
        service: 'games',
        method: 'GET',
        path: '/api/v1/games',
        policy: 'nope',
      },
      {
        code: 'ROUTE_CONFLICT',
        surface: 'account',
        method: 'GET',
        path: '/api/v1/users/:id',
        services: ['games', 'identity'],
      },
      {
        code: 'ROUTE_CONFLICT',
        surface: 'api',
        method: 'GET',
        path: '/v1/users/:id',
        services: ['games', 'identity'],
      },
    ]);
    expect(conflicted.lookup('account', 'GET', '/api/v1/users/1')).toEqual({
      status: 'not_found',
    });
    expect(conflicted.lookup('support', 'GET', '/api/v1/users/1').status).toBe('found');
  });
});
