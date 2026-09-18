import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { definition, router } from './service.ts';

describe('notifier service', () => {
  it('announces webhook admin routes and the manage permission', () => {
    const { routes, permissions } = router.manifest();
    expect(permissions).toEqual([
      expect.objectContaining({ name: 'webhooks.manage', wildcard: true }),
    ]);
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/v1/admin/webhooks/:endpoint_id',
      'GET /api/v1/admin/webhooks',
      'GET /api/v1/admin/webhooks/:endpoint_id',
      'GET /api/v1/admin/webhooks/:endpoint_id/deliveries',
      'PATCH /api/v1/admin/webhooks/:endpoint_id',
      'POST /api/v1/admin/webhooks',
      'POST /api/v1/admin/webhooks/:endpoint_id/deliveries/:delivery_id/replay',
      'POST /api/v1/admin/webhooks/:endpoint_id/secret',
      'POST /api/v1/admin/webhooks/:endpoint_id/test',
    ]);
    const document = openApiDocument(router) as { paths: Record<string, unknown> };
    expect(document.paths['/api/v1/admin/webhooks']).toBeDefined();
  });

  it('ships migrations for the notify schema, starting with the bus tables', async () => {
    expect(definition.database.schema).toBe('notify');
    const migrations = await definition.database.migrations();
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_bus_tables',
      '0002_email_deliveries',
      '0003_webhooks',
    ]);
  });
});
