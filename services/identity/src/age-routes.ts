import { AGE_BANDS, ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { ACTION_REASON_MAX } from './admin-users.ts';
import { isValidDateOfBirth } from './age.ts';
import { editDateOfBirth, type EditDateOfBirthResult } from './date-of-birth.ts';
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
    .max(ACTION_REASON_MAX)
    .describe('Why this date of birth is being changed. Recorded in the audit trail.'),
});

const dateOfBirthSchema = z.object({
  date_of_birth: z.iso.date(),
  age_band: z.enum(AGE_BANDS),
});

function dateOfBirthError(result: Exclude<EditDateOfBirthResult, { status: 'updated' }>): never {
  switch (result.status) {
    case 'not_found':
      throw new ProblemError('ACCOUNT_NOT_FOUND');
    case 'invalid':
      throw new ProblemError('DATE_OF_BIRTH_INVALID');
    case 'unchanged':
      throw new ProblemError('DATE_OF_BIRTH_UNCHANGED');
  }
}

export function ageRoutes(router: Router<Context>): void {
  router.route({
    method: 'POST',
    path: '/api/v1/admin/users/:user_id/date-of-birth',
    operation_id: 'editDateOfBirth',
    summary: 'Change a user’s date of birth',
    description:
      'Staff only. Users cannot edit their own date of birth after signup. Needs a reason, which is stored.',
    tags: ['admin'],
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
      if (result.status !== 'updated') dateOfBirthError(result);
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
    },
  });
}
