import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sections } from '@qtiauth/config';
import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { definition, router } from './service.ts';

describe('games service', () => {
  it('ships migrations for the games schema, starting with the bus tables', async () => {
    expect(definition.database.schema).toBe('games');
    const migrations = await definition.database.migrations();
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_bus_tables',
      '0002_catalog',
    ]);
  });

  it('declares catalog and entitlement routes with rate-limit policies the gateway knows', () => {
    const policies = Object.keys(sections.rate_limits.parse({}));
    const { routes, permissions } = router.manifest();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/v1/admin/games/:slug',
      'DELETE /api/v1/admin/games/:slug/products/:product_slug',
      'GET /api/v1/admin/entitlements',
      'GET /api/v1/admin/games',
      'GET /api/v1/admin/games/:slug',
      'GET /api/v1/admin/games/:slug/products',
      'GET /api/v1/games',
      'GET /api/v1/games/:slug',
      'GET /api/v1/games/:slug/owned',
      'GET /api/v1/games/owned',
      'PATCH /api/v1/admin/games/:slug',
      'PATCH /api/v1/admin/games/:slug/products/:product_slug',
      'POST /api/v1/admin/entitlements/:entitlement_id/revoke',
      'POST /api/v1/admin/games',
      'POST /api/v1/admin/games/:slug/products',
      'POST /api/v1/admin/games/:slug/products/:product_slug/entitlements',
      'POST /api/v1/admin/games/:slug/server-client/rotate',
      'POST /api/v1/games/entitlements',
      'POST /api/v1/games/entitlements/:entitlement_id/revoke',
    ]);
    for (const route of routes) {
      expect(policies).toContain(route.rate_limit);
    }
    expect(permissions.map((permission) => permission.name).sort()).toEqual([
      'games.catalog.manage',
      'games.entitlements.manage',
    ]);
    const document = openApiDocument(router) as { paths: Record<string, unknown> };
    expect(document.paths['/api/v1/games']).toBeDefined();
  });

  it('gates the external grant API on the games.entitlements.write scope', () => {
    const { routes } = router.manifest();
    for (const path of [
      '/api/v1/games/entitlements',
      '/api/v1/games/entitlements/:entitlement_id/revoke',
    ]) {
      const route = routes.find((r) => r.path === path);
      expect(route?.auth).toBe('service');
      expect(route?.scopes).toEqual(['games.entitlements.write']);
    }
  });

  it('requires step-up for server client rotation', () => {
    const { routes } = router.manifest();
    const rotate = routes.find((r) => r.path === '/api/v1/admin/games/:slug/server-client/rotate');
    expect(rotate?.step_up).toBe(true);
  });

  it('never grants entitlements or keys from a bus event, keeping to the trust-model rule', () => {
    const source = readFileSync(join(import.meta.dirname, 'start.ts'), 'utf8');
    expect(source).not.toMatch(/\bconsumeEvents\s*\(/);
    expect(source).not.toMatch(/\bconsumeIdempotentEvents\s*\(/);
  });
});
