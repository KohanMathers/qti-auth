import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { findAccount, OPEN_ACCOUNT_STATES } from './accounts.ts';
import { sendGuardianRemovalRequestEmail, sendGuardianRemovedEmail } from './flows.ts';
import { cancelGuardianRemoval, requestGuardianRemoval } from './graduation.ts';
import { NO_STORE } from './headers.ts';
import { identityMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';

export function graduationRoutes(router: Router<Context>): void {
  router.route({
    method: 'POST',
    path: '/api/v1/me/family/removal',
    operation_id: 'requestFamilyRemoval',
    summary: 'Ask to remove the parent or guardian link, or remove it at the adult band',
    description:
      'After parental.graduation_grace the young person can request removal, which a parent or guardian must approve. At the adult band the link can be removed without approval.',
    tags: ['family'],
    auth: 'session',
    allow_account_states: OPEN_ACCOUNT_STATES,
    rate_limit: 'global',
    responses: {
      202: {
        description: 'A parent or guardian must approve this request',
        schema: z.object({
          status: z.literal('pending_guardian_approval'),
          requested_at: z.iso.datetime(),
        }),
      },
      204: { description: 'The parent or guardian link has been removed' },
    },
    errors: [
      'ACCOUNT_NOT_FOUND',
      'GUARDIAN_NOT_FOUND',
      'GUARDIAN_REMOVAL_NOT_ALLOWED',
      'GUARDIAN_REMOVAL_PENDING',
    ],
    handler: async ({ ctx, identity, log }) => {
      const { userId } = signedIn(identity);
      const account = await findAccount(ctx.db, userId);
      if (!account || account.state === 'deleted') throw new ProblemError('ACCOUNT_NOT_FOUND');
      const result = await requestGuardianRemoval(ctx.db, {
        userId,
        dateOfBirth: account.date_of_birth,
        bands: ctx.config.age.bands,
        consentAge: ctx.config.parental.consent_age,
        graceMs: ctx.config.parental.graduation_grace,
        now: new Date(),
      });
      if (result.status === 'none') throw new ProblemError('GUARDIAN_NOT_FOUND');
      if (result.status === 'blocked') throw new ProblemError('GUARDIAN_REMOVAL_NOT_ALLOWED');
      if (result.status === 'already_pending') throw new ProblemError('GUARDIAN_REMOVAL_PENDING');
      if (result.status === 'pending') {
        await sendGuardianRemovalRequestEmail(ctx, {
          childUserId: userId,
          username: account.username,
          locale: account.locale,
        });
        ctx.outbox.wake();
        identityMetrics(ctx.metrics).graduation('removal_requested');
        log.info('guardian removal requested', { user_id: userId });
        return {
          status: 202,
          headers: NO_STORE,
          body: {
            status: 'pending_guardian_approval' as const,
            requested_at: result.requestedAt.toISOString(),
          },
        };
      }
      await sendGuardianRemovedEmail(ctx, {
        username: account.username,
        locale: account.locale,
        guardians: result.guardians,
      });
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).graduation('removed');
      log.info('guardian link removed', { user_id: userId });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/me/family/removal',
    operation_id: 'cancelFamilyRemoval',
    summary: 'Cancel a pending request to remove the parent or guardian link',
    tags: ['family'],
    auth: 'session',
    allow_account_states: OPEN_ACCOUNT_STATES,
    rate_limit: 'global',
    responses: { 204: { description: 'The request has been cancelled' } },
    errors: ['GUARDIAN_REMOVAL_NOT_FOUND'],
    handler: async ({ ctx, identity, log }) => {
      const { userId } = signedIn(identity);
      const result = await cancelGuardianRemoval(ctx.db, { userId, now: new Date() });
      if (result.status !== 'ok') throw new ProblemError('GUARDIAN_REMOVAL_NOT_FOUND');
      log.info('guardian removal cancelled', { user_id: userId });
      return { status: 204, headers: NO_STORE };
    },
  });
}
