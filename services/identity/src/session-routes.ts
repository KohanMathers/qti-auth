import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import type { RevocationReason } from './database.ts';
import { NO_STORE, revokedHeaders, signedOutHeaders } from './headers.ts';
import { identityMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { listSessions, revokeSessions, sessionExpiry } from './sessions.ts';

const position = z.object({ created_at: z.iso.datetime(), id: z.uuid() });

const sessionSchema = z.object({
  id: z.uuid(),
  current: z.boolean().describe('Whether this is the session making the request.'),
  auth_method: z.string(),
  user_agent: z.string().nullable(),
  created_at: z.iso.datetime(),
  last_active_at: z.iso.datetime(),
  expires_at: z.iso.datetime().describe('When the session ends if it stays idle.'),
});

function signedIn(identity: { sub: string | null; sid: string | null }): {
  userId: string;
  sessionId: string;
} {
  if (identity.sub === null || identity.sid === null) {
    throw new Error('Session routes need a signed-in identity');
  }
  return { userId: identity.sub, sessionId: identity.sid };
}

async function revoke(
  ctx: Context,
  options: {
    userId: string;
    reason: RevocationReason;
    only?: readonly string[];
    except?: string;
  },
): Promise<string[]> {
  const revoked = await ctx.db
    .transaction()
    .execute((trx) => revokeSessions(trx, { ...options, now: new Date() }));
  ctx.outbox.wake();
  identityMetrics(ctx.metrics).sessionsRevoked(options.reason, revoked.length);
  return revoked;
}

export function sessionRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/sessions',
    operation_id: 'listSessions',
    summary: 'List the signed-in user’s sessions, newest first',
    tags: ['sessions'],
    auth: 'session',
    allow_pending_legal: true,
    rate_limit: 'global',
    request: { query: paginationQuery({ defaultLimit: 20, maxLimit: 100 }) },
    responses: { 200: { description: 'Active sessions', schema: pageSchema(sessionSchema) } },
    handler: async ({ ctx, identity, query }) => {
      const { userId, sessionId } = signedIn(identity);
      const idleTimeout = ctx.config.cookies.idle_timeout;
      const rows = await listSessions(ctx.db, {
        userId,
        idleTimeout,
        now: new Date(),
        after: decodeCursor(position, query.cursor),
        limit: query.limit + 1,
      });
      const page = pageOf(rows, query.limit, (row) => ({
        created_at: row.created_at.toISOString(),
        id: row.id,
      }));
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          next_cursor: page.next_cursor,
          items: page.items.map((row) => ({
            id: row.id,
            current: row.id === sessionId,
            auth_method: row.auth_method,
            user_agent: row.user_agent,
            created_at: row.created_at.toISOString(),
            last_active_at: row.last_active_at.toISOString(),
            expires_at: sessionExpiry(row, idleTimeout).toISOString(),
          })),
        },
      };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/sessions/:session_id',
    operation_id: 'revokeSession',
    summary: 'End one session',
    description: 'Ending the current session signs out, like logout.',
    tags: ['sessions'],
    auth: 'session',
    allow_pending_legal: true,
    rate_limit: 'global',
    request: { params: z.object({ session_id: z.uuid() }) },
    responses: { 204: { description: 'The session has ended on every surface' } },
    errors: ['SESSION_NOT_FOUND'],
    handler: async ({ ctx, identity, params, log }) => {
      const { userId, sessionId } = signedIn(identity);
      const revoked = await revoke(ctx, {
        userId,
        reason: 'revoked',
        only: [params.session_id],
      });
      if (revoked.length === 0) throw new ProblemError('SESSION_NOT_FOUND');
      log.info('session revoked', { session_id: params.session_id });
      return {
        status: 204,
        headers:
          params.session_id === sessionId ? signedOutHeaders(revoked) : revokedHeaders(revoked),
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/sessions/revoke-others',
    operation_id: 'revokeOtherSessions',
    summary: 'End every session except the current one',
    tags: ['sessions'],
    auth: 'session',
    allow_pending_legal: true,
    rate_limit: 'global',
    responses: {
      200: {
        description: 'The other sessions have ended',
        schema: z.object({ revoked: z.int().describe('How many sessions ended.') }),
      },
    },
    handler: async ({ ctx, identity, log }) => {
      const { userId, sessionId } = signedIn(identity);
      const revoked = await revoke(ctx, { userId, reason: 'revoked', except: sessionId });
      log.info('other sessions revoked', { revoked: revoked.length });
      return { status: 200, headers: revokedHeaders(revoked), body: { revoked: revoked.length } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/sessions/revoke-all',
    operation_id: 'revokeAllSessions',
    summary: 'End every session, including the current one',
    tags: ['sessions'],
    auth: 'session',
    allow_pending_legal: true,
    rate_limit: 'global',
    responses: { 204: { description: 'Every session has ended. The session cookie is cleared.' } },
    handler: async ({ ctx, identity, log }) => {
      const { userId } = signedIn(identity);
      const revoked = await revoke(ctx, { userId, reason: 'revoked' });
      log.info('all sessions revoked', { revoked: revoked.length });
      return { status: 204, headers: signedOutHeaders(revoked) };
    },
  });
}
