import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { isValidDateOfBirth } from './age.ts';
import { editDateOfBirth } from './date-of-birth.ts';
import { NO_STORE } from './headers.ts';
import { identityMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';

const dateOfBirthBody = z.object({
  date_of_birth: z.iso
    .date()
    .refine((value) => isValidDateOfBirth(value, new Date()), 'Must be a real date of birth')
    .describe('YYYY-MM-DD.'),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe('Why this date of birth is being changed. Recorded in the audit trail.'),
});

const dateOfBirthSchema = z.object({
  date_of_birth: z.iso.date(),
  age_band: z.string(),
});

export function ageRoutes(router: Router<Context>): void {
  router.route({
    method: 'POST',
    path: '/api/v1/admin/users/:user_id/date-of-birth',
    operation_id: 'editDateOfBirth',
    summary: 'Change a user’s date of birth',
    description:
      'Staff only. Users cannot edit their own date of birth after signup. Needs a reason, which is stored.',
    tags: ['account'],
    auth: 'session',
    permissions: ['users.edit_dob'],
    step_up: true,
    rate_limit: 'global',
    request: {
      params: z.object({ user_id: z.uuid() }),
      body: dateOfBirthBody,
    },
    responses: {
      200: { description: 'The date of birth was changed', schema: dateOfBirthSchema },
    },
    errors: ['ACCOUNT_NOT_FOUND', 'DATE_OF_BIRTH_INVALID', 'DATE_OF_BIRTH_UNCHANGED'],
    handler: async ({ ctx, identity, params, body, log }) => {
      const { userId: actorId } = signedIn(identity);
      const result = await editDateOfBirth(ctx.db, {
        userId: params.user_id,
        actorId,
        dateOfBirth: body.date_of_birth,
        reason: body.reason,
        bands: ctx.config.age.bands,
        now: new Date(),
      });
      switch (result.status) {
        case 'not_found':
          throw new ProblemError('ACCOUNT_NOT_FOUND');
        case 'invalid':
          throw new ProblemError('DATE_OF_BIRTH_INVALID');
        case 'unchanged':
          throw new ProblemError('DATE_OF_BIRTH_UNCHANGED');
        case 'updated':
          ctx.outbox.wake();
          if (result.previousAgeBand !== result.ageBand) {
            identityMetrics(ctx.metrics).ageBandChanged(1);
          }
          log.info('date of birth edited', { user_id: params.user_id });
          return {
            status: 200,
            headers: NO_STORE,
            body: { date_of_birth: result.dateOfBirth, age_band: result.ageBand },
          };
      }
    },
  });
}
