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
      '0003_keys',
      '0004_achievements',
      '0005_stats',
      '0006_licensing',
      '0007_cloud_saves',
    ]);
  });

  it('declares catalog and entitlement routes with rate-limit policies the gateway knows', () => {
    const policies = Object.keys(sections.rate_limits.parse({}));
    const { routes, permissions } = router.manifest();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/v1/admin/games/:slug',
      'DELETE /api/v1/admin/games/:slug/achievements/:achievement_slug',
      'DELETE /api/v1/admin/games/:slug/products/:product_slug',
      'DELETE /api/v1/admin/games/:slug/stats/:key',
      'DELETE /api/v1/admin/leaderboards/:leaderboard_id',
      'DELETE /api/v1/games/:slug/cloud-saves/:slot',
      'DELETE /api/v1/games/:slug/cloud-saves/:slot/uploads/:version_id',
      'DELETE /api/v1/games/:slug/licensing/devices/:lease_id',
      'GET /.well-known/qtiauth-license-keys.json',
      'GET /api/v1/admin/entitlements',
      'GET /api/v1/admin/entitlements/:entitlement_id',
      'GET /api/v1/admin/games',
      'GET /api/v1/admin/games/:slug',
      'GET /api/v1/admin/games/:slug/achievements',
      'GET /api/v1/admin/games/:slug/key-batches',
      'GET /api/v1/admin/games/:slug/leaderboards',
      'GET /api/v1/admin/games/:slug/licenses',
      'GET /api/v1/admin/games/:slug/products',
      'GET /api/v1/admin/games/:slug/stats',
      'GET /api/v1/admin/key-batches/:batch_id',
      'GET /api/v1/admin/key-batches/:batch_id/keys.csv',
      'GET /api/v1/games',
      'GET /api/v1/games/:slug',
      'GET /api/v1/games/:slug/achievements',
      'GET /api/v1/games/:slug/cloud-saves',
      'GET /api/v1/games/:slug/cloud-saves/:slot',
      'GET /api/v1/games/:slug/cloud-saves/:slot/download',
      'GET /api/v1/games/:slug/cloud-saves/:slot/versions',
      'GET /api/v1/games/:slug/custom-data',
      'GET /api/v1/games/:slug/leaderboards/:stat/:board',
      'GET /api/v1/games/:slug/licensing/devices',
      'GET /api/v1/games/:slug/owned',
      'GET /api/v1/games/:slug/playtime/remaining',
      'GET /api/v1/games/:slug/stats',
      'GET /api/v1/games/:slug/stats/values',
      'GET /api/v1/games/keys/captcha',
      'GET /api/v1/games/licensing/revocations',
      'GET /api/v1/games/owned',
      'PATCH /api/v1/admin/games/:slug',
      'PATCH /api/v1/admin/games/:slug/achievements/:achievement_slug',
      'PATCH /api/v1/admin/games/:slug/products/:product_slug',
      'PATCH /api/v1/admin/games/:slug/stats/:key',
      'PATCH /api/v1/admin/leaderboards/:leaderboard_id',
      'POST /api/v1/admin/achievement-unlocks/:unlock_id/revoke',
      'POST /api/v1/admin/entitlements/:entitlement_id/revoke',
      'POST /api/v1/admin/games',
      'POST /api/v1/admin/games/:slug/achievements',
      'POST /api/v1/admin/games/:slug/leaderboards',
      'POST /api/v1/admin/games/:slug/products',
      'POST /api/v1/admin/games/:slug/products/:product_slug/entitlements',
      'POST /api/v1/admin/games/:slug/products/:product_slug/key-batches',
      'POST /api/v1/admin/games/:slug/server-client/rotate',
      'POST /api/v1/admin/games/:slug/stats',
      'POST /api/v1/admin/key-batches/:batch_id/revoke',
      'POST /api/v1/admin/leaderboards/:leaderboard_id/entries/:user_id/remove',
      'POST /api/v1/admin/licenses/:lease_id/revoke',
      'POST /api/v1/games/:slug/achievements/progress',
      'POST /api/v1/games/:slug/achievements/unlock',
      'POST /api/v1/games/:slug/cloud-saves/:slot/commit',
      'POST /api/v1/games/:slug/cloud-saves/:slot/uploads',
      'POST /api/v1/games/:slug/leaderboards/:stat/:board/visibility',
      'POST /api/v1/games/:slug/licensing/leases',
      'POST /api/v1/games/:slug/playtime/:session_id/end',
      'POST /api/v1/games/:slug/playtime/:session_id/heartbeat',
      'POST /api/v1/games/:slug/playtime/start',
      'POST /api/v1/games/:slug/stats/:key/update',
      'POST /api/v1/games/entitlements',
      'POST /api/v1/games/entitlements/:entitlement_id/revoke',
      'POST /api/v1/games/keys/redeem',
      'POST /api/v1/games/licensing/verify',
      'POST /api/v1/games/steam/authenticate',
      'PUT /api/v1/games/:slug/custom-data',
    ]);
    for (const route of routes) {
      expect(policies).toContain(route.rate_limit);
    }
    expect(permissions.map((permission) => permission.name).sort()).toEqual([
      'games.achievements.manage',
      'games.catalog.manage',
      'games.entitlements.manage',
      'games.keys.manage',
      'games.licensing.manage',
      'games.stats.manage',
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

  it('requires step-up for the batch CSV export', () => {
    const { routes } = router.manifest();
    const csv = routes.find((r) => r.path === '/api/v1/admin/key-batches/:batch_id/keys.csv');
    expect(csv?.step_up).toBe(true);
    expect(csv?.permissions).toContain('games.keys.manage');
  });

  it('rate-limits key redemption with the key_redeem policy', () => {
    const { routes } = router.manifest();
    const redeem = routes.find((r) => r.path === '/api/v1/games/keys/redeem');
    expect(redeem?.rate_limit).toBe('key_redeem');
    expect(redeem?.auth).toBe('session');
  });

  it('never grants entitlements or keys from a bus event, keeping to the trust-model rule', () => {
    const source = readFileSync(join(import.meta.dirname, 'start.ts'), 'utf8');
    expect(source).not.toMatch(/\bconsumeEvents\s*\(/);
    expect(source).not.toMatch(/\bconsumeIdempotentEvents\s*\(/);
  });
});
