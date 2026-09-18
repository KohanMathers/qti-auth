import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { SIGNED_IN_STATES } from './accounts.ts';
import { completeExport, getExport, requestExport } from './exports.ts';
import { NO_STORE, signedOutHeaders } from './headers.ts';
import { requestDeletion } from './lifecycle.ts';
import { identityMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';
import { objectStoreOf } from './storage-state.ts';

const exportIdParam = z.object({ export_id: z.uuid() });

const exportSchema = z.object({
  id: z.uuid(),
  status: z.enum(['pending', 'ready', 'failed', 'unavailable']),
  download_url: z.string().nullable(),
  bytes: z.int().nullable(),
  expires_at: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});

function exportSettings(ctx: Context) {
  return {
    ttl: ctx.config.accounts.export_ttl,
    emailMaxBytes: ctx.config.accounts.export_email_max_bytes,
    defaultLocale: ctx.config.email.default_locale,
  };
}

export function lifecycleRoutes(router: Router<Context>): void {
  router.route({
    method: 'POST',
    path: '/api/v1/me/deletion',
    operation_id: 'requestDeletion',
    summary: 'Ask for this account to be deleted',
    description:
      'Needs a recent aal2 session. The account moves to pending_deletion for accounts.deletion_grace and every session ends. Signing in during that time cancels the deletion.',
    tags: ['account'],
    auth: 'session',
    step_up: true,
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    responses: { 204: { description: 'Deletion is scheduled and this session has ended' } },
    errors: ['ACCOUNT_NOT_FOUND', 'ACCOUNT_STATE_CONFLICT', 'STEP_UP_REQUIRED'],
    handler: async ({ ctx, identity, log }) => {
      const { userId } = signedIn(identity);
      const result = await requestDeletion(ctx.db, {
        userId,
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('ACCOUNT_NOT_FOUND');
      if (result.status === 'conflict') throw new ProblemError('ACCOUNT_STATE_CONFLICT');
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).deletion('requested');
      identityMetrics(ctx.metrics).sessionsRevoked('revoked', result.revoked.length);
      log.info('account deletion requested', { user_id: userId });
      return { status: 204, headers: signedOutHeaders(result.revoked) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/export',
    operation_id: 'requestExport',
    summary: 'Request a copy of this account’s data',
    description:
      'Needs a recent aal2 session. When object storage is configured, a download link is emailed. Without storage, the zip is emailed as an attachment if it is under accounts.export_email_max_bytes.',
    tags: ['account'],
    auth: 'session',
    step_up: true,
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    responses: {
      202: {
        description: 'The export is being prepared',
        schema: z.object({ id: z.uuid(), status: z.literal('pending') }),
      },
    },
    errors: ['ACCOUNT_NOT_FOUND', 'STEP_UP_REQUIRED'],
    handler: async ({ ctx, identity, log }) => {
      const { userId } = signedIn(identity);
      const result = await requestExport(ctx.db, { userId, now: new Date() });
      if (result.status === 'not_found') throw new ProblemError('ACCOUNT_NOT_FOUND');
      const store = objectStoreOf(ctx) ?? null;
      void completeExport(ctx.db, ctx.bus, result.id, {
        store,
        settings: exportSettings(ctx),
        metrics: ctx.busMetrics,
        now: new Date(),
      }).then(
        (status) => {
          if (status === 'ready' || status === 'failed' || status === 'unavailable') {
            identityMetrics(ctx.metrics).dataExport(status);
          }
        },
        (error: unknown) => {
          ctx.log.error('data export failed', { error, export_id: result.id });
        },
      );
      log.info('data export requested', { user_id: userId, export_id: result.id });
      return {
        status: 202,
        headers: NO_STORE,
        body: { id: result.id, status: 'pending' as const },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/me/export/:export_id',
    operation_id: 'getExport',
    summary: 'The status of a requested data export',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    request: { params: exportIdParam },
    responses: { 200: { description: 'The export status', schema: exportSchema } },
    errors: ['ACCOUNT_NOT_FOUND', 'EXPORT_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const { userId } = signedIn(identity);
      const exported = await getExport(ctx.db, {
        userId,
        exportId: params.export_id,
        store: objectStoreOf(ctx) ?? null,
        now: new Date(),
      });
      if (!exported) throw new ProblemError('EXPORT_NOT_FOUND');
      return { status: 200, headers: NO_STORE, body: exported };
    },
  });
}
