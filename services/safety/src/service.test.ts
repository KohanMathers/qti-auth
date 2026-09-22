import { sections } from '@qtiauth/config';
import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { definition, router } from './service.ts';

describe('safety service', () => {
  it('ships migrations for the safety schema, starting with the bus tables', async () => {
    expect(definition.database.schema).toBe('safety');
    const migrations = await definition.database.migrations();
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_bus_tables',
      '0002_reports',
      '0003_moderation',
    ]);
  });

  it('declares report intake routes with rate-limit policies the gateway knows', () => {
    const policies = Object.keys(sections.rate_limits.parse({}));
    const { routes, permissions } = router.manifest();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'GET /api/v1/admin/safety/appeals',
      'GET /api/v1/admin/safety/catalog',
      'GET /api/v1/admin/safety/moderators/:moderator_id/history',
      'GET /api/v1/admin/safety/reports',
      'GET /api/v1/admin/safety/reports/:report_id',
      'GET /api/v1/admin/safety/users/:user_id/history',
      'GET /api/v1/safety/appeals',
      'GET /api/v1/safety/reports/:report_id',
      'GET /api/v1/safety/taxonomy',
      'POST /api/v1/admin/safety/appeals/:appeal_id/resolve',
      'POST /api/v1/admin/safety/approvals/:approval_id/confirm',
      'POST /api/v1/admin/safety/reports/:report_id/actions',
      'POST /api/v1/admin/safety/reports/:report_id/dismiss',
      'POST /api/v1/safety/appeals',
      'POST /api/v1/safety/intake/flags',
      'POST /api/v1/safety/intake/reports',
      'POST /api/v1/safety/reports',
    ]);
    for (const route of routes) {
      expect(policies).toContain(route.rate_limit);
    }
    expect(permissions.map((permission) => permission.name).sort()).toEqual([
      'safety.actions.apply',
      'safety.reports.read',
      'safety.reports.submit',
    ]);
    const document = openApiDocument(router) as { paths: Record<string, unknown> };
    expect(document.paths['/api/v1/safety/reports']).toBeDefined();
  });

  it('accepts service and OAuth callers on the intake routes', () => {
    const { routes } = router.manifest();
    for (const path of ['/api/v1/safety/intake/reports', '/api/v1/safety/intake/flags']) {
      const route = routes.find((r) => r.path === path);
      expect(route?.auth).toBe('service');
      expect(route?.scopes).toEqual(['safety.reports.submit']);
    }
  });
});
