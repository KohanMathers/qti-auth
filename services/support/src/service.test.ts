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
      '0003_guest_attachments',
      '0004_knowledge_base',
    ]);
  });

  it('declares ticket routes with rate-limit policies the gateway knows', () => {
    const policies = Object.keys(sections.rate_limits.parse({}));
    const { routes, permissions, notifications } = router.manifest();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/v1/admin/support/kb/articles/:article_id',
      'DELETE /api/v1/admin/support/kb/categories/:category_id',
      'DELETE /api/v1/admin/support/macros/:macro_id',
      'GET /api/v1/admin/support/kb/articles',
      'GET /api/v1/admin/support/kb/articles/:article_id',
      'GET /api/v1/admin/support/kb/articles/:article_id/revisions',
      'GET /api/v1/admin/support/kb/articles/:article_id/revisions/:revision',
      'GET /api/v1/admin/support/kb/articles/:article_id/revisions/:revision/diff',
      'GET /api/v1/admin/support/kb/categories',
      'GET /api/v1/admin/support/macros',
      'GET /api/v1/admin/support/metrics',
      'GET /api/v1/admin/support/tickets',
      'GET /api/v1/admin/support/tickets/:ticket_id',
      'GET /api/v1/support/categories',
      'GET /api/v1/support/guest/captcha',
      'GET /api/v1/support/guest/categories',
      'GET /api/v1/support/kb/articles',
      'GET /api/v1/support/kb/articles/:slug',
      'GET /api/v1/support/kb/categories',
      'GET /api/v1/support/kb/categories/:slug',
      'GET /api/v1/support/kb/images/:image_id',
      'GET /api/v1/support/kb/related',
      'GET /api/v1/support/kb/search',
      'GET /api/v1/support/tickets',
      'GET /api/v1/support/tickets/:ticket_id',
      'PATCH /api/v1/admin/support/kb/articles/:article_id',
      'PATCH /api/v1/admin/support/kb/categories/:category_id',
      'PATCH /api/v1/admin/support/macros/:macro_id',
      'PATCH /api/v1/admin/support/tickets/:ticket_id',
      'POST /api/v1/admin/support/kb/articles',
      'POST /api/v1/admin/support/kb/articles/:article_id/revisions/:revision/restore',
      'POST /api/v1/admin/support/kb/categories',
      'POST /api/v1/admin/support/kb/images',
      'POST /api/v1/admin/support/macros',
      'POST /api/v1/admin/support/tickets/:ticket_id/attachments',
      'POST /api/v1/admin/support/tickets/:ticket_id/attachments/:attachment_id/download',
      'POST /api/v1/admin/support/tickets/:ticket_id/close',
      'POST /api/v1/admin/support/tickets/:ticket_id/notes',
      'POST /api/v1/admin/support/tickets/:ticket_id/reopen',
      'POST /api/v1/admin/support/tickets/:ticket_id/replies',
      'POST /api/v1/support/appeals',
      'POST /api/v1/support/guest/attachments',
      'POST /api/v1/support/guest/attachments/download',
      'POST /api/v1/support/guest/codes',
      'POST /api/v1/support/guest/tickets',
      'POST /api/v1/support/guest/tickets/close',
      'POST /api/v1/support/guest/tickets/rate',
      'POST /api/v1/support/guest/tickets/reopen',
      'POST /api/v1/support/guest/tickets/replies',
      'POST /api/v1/support/guest/tickets/view',
      'POST /api/v1/support/kb/articles/:slug/feedback',
      'POST /api/v1/support/tickets',
      'POST /api/v1/support/tickets/:ticket_id/attachments',
      'POST /api/v1/support/tickets/:ticket_id/attachments/:attachment_id/download',
      'POST /api/v1/support/tickets/:ticket_id/close',
      'POST /api/v1/support/tickets/:ticket_id/rate',
      'POST /api/v1/support/tickets/:ticket_id/reopen',
      'POST /api/v1/support/tickets/:ticket_id/replies',
    ]);
    for (const route of routes) {
      expect(policies).toContain(route.rate_limit);
    }
    expect(permissions.map((permission) => permission.name).sort()).toEqual([
      'support.kb.edit',
      'support.tickets.staff',
    ]);
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
    expect(routes.find((route) => route.path === '/api/v1/support/guest/codes')).toMatchObject({
      auth: 'none',
      rate_limit: 'guest_ticket',
    });
    expect(routes.find((route) => route.path === '/api/v1/support/guest/tickets')).toMatchObject({
      auth: 'none',
      rate_limit: 'guest_ticket',
    });
    const document = openApiDocument(router) as { paths: Record<string, unknown> };
    expect(document.paths['/api/v1/support/tickets']).toBeDefined();
  });
});
