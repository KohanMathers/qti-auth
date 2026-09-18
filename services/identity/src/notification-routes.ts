import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { findAccount, SIGNED_IN_STATES } from './accounts.ts';
import { NO_STORE } from './headers.ts';
import { listedNotifications } from './notification-registry.ts';
import { listPreferences, setPreferences } from './notifications.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';

const categorySchema = z.object({
  id: z.string(),
  description: z.string(),
  audience: z.enum(['user', 'staff']),
  disableable: z.boolean(),
  enabled: z.boolean(),
  service: z.string(),
});

const preferencesSchema = z.object({ categories: z.array(categorySchema) });

const patchBody = z.object({
  categories: z
    .array(
      z.object({
        id: z.string().min(1).describe('The category id, such as support.ticket_updates.'),
        enabled: z.boolean(),
      }),
    )
    .min(1),
});

function isStaff(permissions: readonly string[]): boolean {
  return permissions.length > 0;
}

export function notificationRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/me/notifications',
    operation_id: 'getMyNotifications',
    summary: 'Notification categories this account can toggle',
    description:
      'Security and legal categories are listed but cannot be turned off. Staff-only alert categories appear when the caller has any staff permission.',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    responses: { 200: { description: 'The current preferences', schema: preferencesSchema } },
    errors: ['ACCOUNT_NOT_FOUND'],
    handler: async ({ ctx, identity }) => {
      const { userId } = signedIn(identity);
      if (!(await findAccount(ctx.db, userId))) throw new ProblemError('ACCOUNT_NOT_FOUND');
      const categories = await listPreferences(ctx.db, {
        userId,
        catalog: listedNotifications(ctx),
        staff: isStaff(identity.permissions),
      });
      return { status: 200, headers: NO_STORE, body: { categories } };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/me/notifications',
    operation_id: 'updateMyNotifications',
    summary: 'Turn optional notification categories on or off',
    description:
      'Security and legal categories cannot be disabled. Categories the caller cannot see answer as not found.',
    tags: ['account'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    rate_limit: 'global',
    request: { body: patchBody },
    responses: { 200: { description: 'The updated preferences', schema: preferencesSchema } },
    errors: ['ACCOUNT_NOT_FOUND', 'NOTIFICATION_CATEGORY_NOT_FOUND', 'NOTIFICATION_REQUIRED'],
    handler: async ({ ctx, identity, body, log }) => {
      const { userId } = signedIn(identity);
      if (!(await findAccount(ctx.db, userId))) throw new ProblemError('ACCOUNT_NOT_FOUND');
      const result = await setPreferences(ctx.db, {
        userId,
        catalog: listedNotifications(ctx),
        staff: isStaff(identity.permissions),
        updates: body.categories,
        now: new Date(),
      });
      if (result.status === 'unknown') throw new ProblemError('NOTIFICATION_CATEGORY_NOT_FOUND');
      if (result.status === 'required') throw new ProblemError('NOTIFICATION_REQUIRED');
      ctx.outbox.wake();
      log.info('notification preferences updated', { user_id: userId });
      return { status: 200, headers: NO_STORE, body: { categories: result.categories } };
    },
  });
}
