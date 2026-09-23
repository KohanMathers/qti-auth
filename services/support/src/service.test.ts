import { sections } from '@qtiauth/config';
import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { definition, router } from './service.ts';

describe('support service', () => {
  it('ships migrations for the support schema, starting with the bus tables', async () => {
    expect(definition.database.schema).toBe('support');
    const migrations = await definition.database.migrations();
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_bus_tables',
      '0002_tickets',
    ]);
  });

  it('declares ticket routes with rate-limit policies the gateway knows', () => {
    const policies = Object.keys(sections.rate_limits.parse({}));
    const { routes, permissions, notifications } = router.manifest();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/v1/admin/support/macros/:macro_id',
      'GET /api/v1/admin/support/macros',
      'GET /api/v1/admin/support/metrics',
      'GET /api/v1/admin/support/tickets',
      'GET /api/v1/admin/support/tickets/:ticket_id',
      'GET /api/v1/support/categories',
      'GET /api/v1/support/tickets',
      'GET /api/v1/support/tickets/:ticket_id',
      'PATCH /api/v1/admin/support/macros/:macro_id',
      'PATCH /api/v1/admin/support/tickets/:ticket_id',
      'POST /api/v1/admin/support/macros',
      'POST /api/v1/admin/support/tickets/:ticket_id/close',
      'POST /api/v1/admin/support/tickets/:ticket_id/notes',
      'POST /api/v1/admin/support/tickets/:ticket_id/reopen',
      'POST /api/v1/admin/support/tickets/:ticket_id/replies',
      'POST /api/v1/support/appeals',
      'POST /api/v1/support/tickets',
      'POST /api/v1/support/tickets/:ticket_id/close',
      'POST /api/v1/support/tickets/:ticket_id/rate',
      'POST /api/v1/support/tickets/:ticket_id/reopen',
      'POST /api/v1/support/tickets/:ticket_id/replies',
    ]);
    for (const route of routes) {
      expect(policies).toContain(route.rate_limit);
    }
    expect(permissions.map((permission) => permission.name)).toEqual(['support.tickets.staff']);
    expect(notifications.map((category) => category.name).sort()).toEqual([
      'support.new_tickets',
      'support.ticket_updates',
    ]);
    expect(
      routes.find((route) => route.path === '/api/v1/support/appeals')?.allow_account_states,
    ).toEqual(['active', 'banned', 'locked']);
    expect(
      routes.find((route) => route.path === '/api/v1/support/tickets' && route.method === 'POST')
        ?.allow_account_states,
    ).toEqual(['active']);
    const document = openApiDocument(router) as { paths: Record<string, unknown> };
    expect(document.paths['/api/v1/support/tickets']).toBeDefined();
  });
});
