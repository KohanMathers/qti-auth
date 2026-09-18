import { ACTOR_TYPES } from '@qtiauth/events';
import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import { listAuditRecords } from './audit.ts';
import { NO_STORE } from './headers.ts';
import type { Context } from './service.ts';

const position = z.object({ seq: z.int().positive() });

const recordSchema = z.object({
  seq: z.int(),
  event_id: z.string(),
  occurred_at: z.iso.datetime(),
  actor_type: z.enum(ACTOR_TYPES),
  actor_id: z.string(),
  action: z.string(),
  target_type: z.string(),
  target_id: z.string(),
});

const listQuery = paginationQuery({ defaultLimit: 20, maxLimit: 100 }).extend({
  actor_id: z.string().min(1).optional().describe('Only rows whose actor id matches.'),
  actor_type: z.enum(ACTOR_TYPES).optional().describe('Only rows with this actor type.'),
  action: z.string().min(1).optional().describe('Only this action, such as role.updated.'),
  target_type: z.string().min(1).optional().describe('Only this kind of target, such as role.'),
  target_id: z.string().min(1).optional().describe("Only this target's id."),
  from: z.iso.datetime().optional().describe('Only rows at or after this time.'),
  to: z.iso.datetime().optional().describe('Only rows at or before this time.'),
});

export function auditRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/audit',
    operation_id: 'listAudit',
    summary: 'Audit log, newest first',
    description: 'Staff and security-sensitive actions stored from audit.recorded events.',
    tags: ['audit'],
    auth: 'session',
    permissions: ['audit.read'],
    rate_limit: 'global',
    request: { query: listQuery },
    responses: { 200: { description: 'Matching audit rows', schema: pageSchema(recordSchema) } },
    handler: async ({ ctx, query }) => {
      const after = decodeCursor(position, query.cursor)?.seq;
      const rows = await listAuditRecords(ctx.db, {
        limit: query.limit + 1,
        ...(after === undefined ? {} : { after }),
        ...(query.actor_id === undefined ? {} : { actor_id: query.actor_id }),
        ...(query.actor_type === undefined ? {} : { actor_type: query.actor_type }),
        ...(query.action === undefined ? {} : { action: query.action }),
        ...(query.target_type === undefined ? {} : { target_type: query.target_type }),
        ...(query.target_id === undefined ? {} : { target_id: query.target_id }),
        ...(query.from === undefined ? {} : { from: new Date(query.from) }),
        ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      });
      const page = pageOf(rows, query.limit, (row) => ({ seq: row.seq }));
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          next_cursor: page.next_cursor,
          items: page.items.map((row) => ({
            seq: row.seq,
            event_id: row.event_id,
            occurred_at: row.occurred_at.toISOString(),
            actor_type: row.actor_type,
            actor_id: row.actor_id,
            action: row.action,
            target_type: row.target_type,
            target_id: row.target_id,
          })),
        },
      };
    },
  });
}
