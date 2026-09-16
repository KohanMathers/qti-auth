import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { openApiDocument, openApiPath } from './openapi.ts';
import { paginationQuery } from './pagination.ts';
import { definePermissions } from './permissions.ts';
import { defineErrors } from './problems.ts';
import { createRouter } from './routes.ts';

function exampleRouter() {
  const router = createRouter<undefined>({
    service: 'support',
    version: '0.3.0',
    module: 'support',
    permissions: definePermissions({ 'support.tickets.staff': { description: 'Staff tickets' } }),
    errors: defineErrors({ TICKET_NOT_FOUND: { status: 404, title: 'Ticket not found' } }),
  });
  router.route({
    method: 'GET',
    path: '/api/v1/support/tickets',
    operation_id: 'listTickets',
    summary: 'List tickets',
    tags: ['tickets'],
    auth: 'session',
    rate_limit: 'global',
    request: { query: paginationQuery() },
    responses: {
      200: { description: 'A page of tickets', schema: z.object({ items: z.array(z.string()) }) },
    },
    handler: () => Promise.resolve({ status: 200 as const, body: { items: [] } }),
  });
  router.route({
    method: 'PATCH',
    path: '/api/v1/support/tickets/:ticket_id',
    operation_id: 'updateTicket',
    summary: 'Update a ticket',
    auth: 'session',
    permissions: ['support.tickets.staff'],
    rate_limit: 'global',
    request: {
      params: z.object({ ticket_id: z.uuid().describe('Ticket ID') }),
      body: z.object({ status: z.enum(['open', 'closed']) }),
    },
    responses: { 204: { description: 'Updated' } },
    errors: ['TICKET_NOT_FOUND'],
    handler: () => Promise.resolve({ status: 204 as const }),
  });
  return router;
}

describe('openApiPath', () => {
  it('turns :params into {params}', () => {
    expect(openApiPath('/api/v1/users/:user_id/sessions/:id')).toBe(
      '/api/v1/users/{user_id}/sessions/{id}',
    );
  });
});

describe('openApiDocument', () => {
  const document = openApiDocument(exampleRouter()) as {
    openapi: string;
    info: unknown;
    paths: Record<string, Record<string, Record<string, unknown>>>;
    'x-qtiauth-errors': { code: string }[];
    'x-qtiauth-permissions': unknown[];
  };

  it('describes the service', () => {
    expect(document.openapi).toBe('3.1.1');
    expect(document.info).toEqual({ title: 'QTIAuth support', version: '0.3.0' });
    expect(document['x-qtiauth-errors'].map((e) => e.code)).toContain('TICKET_NOT_FOUND');
    expect(document['x-qtiauth-permissions']).toEqual([
      { name: 'support.tickets.staff', description: 'Staff tickets', wildcard: true },
    ]);
  });

  it('documents query parameters', () => {
    const list = document.paths['/api/v1/support/tickets']?.['get'];
    expect(list).toMatchObject({ operationId: 'listTickets', tags: ['tickets'] });
    expect(list?.['parameters']).toEqual([
      {
        name: 'limit',
        in: 'query',
        required: false,
        description: 'Items per page, up to 100.',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description: 'next_cursor from the previous page. Leave out for the first page.',
        schema: { type: 'string', minLength: 1, maxLength: 1024 },
      },
    ]);
  });

  it('documents path parameters, the body, policy and every error code by status', () => {
    const update = document.paths['/api/v1/support/tickets/{ticket_id}']?.['patch'];
    expect(update?.['parameters']).toEqual([
      expect.objectContaining({
        name: 'ticket_id',
        in: 'path',
        required: true,
        description: 'Ticket ID',
      }),
    ]);
    expect(update?.['requestBody']).toMatchObject({
      required: true,
      content: { 'application/json': { schema: { type: 'object', required: ['status'] } } },
    });
    expect(update?.['x-qtiauth-policy']).toMatchObject({ permissions: ['support.tickets.staff'] });

    const responses = update?.['responses'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(responses)).toEqual([
      '204',
      '400',
      '401',
      '403',
      '404',
      '415',
      '500',
      '503',
    ]);
    expect(responses['204']).toEqual({ description: 'Updated' });
    expect(responses['400']?.['x-qtiauth-error-codes']).toEqual([
      'VALIDATION_FAILED',
      'INVALID_JSON',
    ]);
    expect(responses['403']?.['x-qtiauth-error-codes']).toEqual([
      'ACCOUNT_STATE_NOT_ALLOWED',
      'PERMISSION_DENIED',
    ]);
    expect(responses['404']).toMatchObject({
      'x-qtiauth-error-codes': ['TICKET_NOT_FOUND'],
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
      },
    });
  });
});
