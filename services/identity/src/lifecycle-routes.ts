import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { SIGNED_IN_STATES } from './accounts.ts';
import { DATA_EXPORT_STATUSES } from './database.ts';
import { getExport } from './exports.ts';
import { scheduleDeletion, startDataExport } from './flows.ts';
import { NO_STORE, signedOutHeaders } from './headers.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';
import { objectStoreOf } from './storage-state.ts';

const exportIdParam = z.object({ export_id: z.uuid() });

const exportSchema = z.object({
  id: z.uuid(),
  status: z.enum(DATA_EXPORT_STATUSES),
  download_url: z.string().nullable(),
  bytes: z.int().nullable(),
  expires_at: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});

export function lifecycleRoutes(router: Router<Context>): void {
  router.route({
    method: 'POST',
    path: '/api/v1/me/deletion',
    operation_id: 'requestDeletion',
    summary: 'Ask for this account to be deleted',
    description:
      'Needs a recent aal2 session. The account moves to pending_deletion for accounts.deletion_grace and every session ends. Signing in during that time cancels the deletion and restores the prior account state.',
    tags: ['account'],
    auth: 'session',
    step_up: true,
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    responses: { 204: { description: 'Deletion is scheduled and this session has ended' } },
    errors: ['ACCOUNT_NOT_FOUND', 'ACCOUNT_STATE_CONFLICT', 'STEP_UP_REQUIRED'],
    handler: async ({ ctx, identity, request, log }) => {
      const { userId } = signedIn(identity);
      const result = await scheduleDeletion({ ctx, request, log }, { userId });
      if (result.status === 'not_found') throw new ProblemError('ACCOUNT_NOT_FOUND');
      if (result.status === 'conflict') throw new ProblemError('ACCOUNT_STATE_CONFLICT');
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
    handler: async ({ ctx, identity, request, log }) => {
      const { userId } = signedIn(identity);
      const result = await startDataExport({ ctx, request, log }, { userId });
      if (result.status === 'not_found') throw new ProblemError('ACCOUNT_NOT_FOUND');
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
        store: objectStoreOf(ctx),
        now: new Date(),
      });
      if (!exported) throw new ProblemError('EXPORT_NOT_FOUND');
      return { status: 200, headers: NO_STORE, body: exported };
    },
  });
}
