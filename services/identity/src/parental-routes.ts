import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { isValidDateOfBirth } from './age.ts';
import {
  grantParentalConsent,
  pendingParentalConsent,
  refuseParentalConsent,
  resendParentalConsent,
  updateGuardianEmail,
} from './flows.ts';
import { NO_STORE } from './headers.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';

const tokenBody = z.object({ token: z.string().min(1).max(256) });

const consentSchema = z.object({
  guardian_email: z.string(),
  email_changes_remaining: z.int(),
  expires_at: z.iso.datetime(),
});

export function throwGuardianSignup(
  status: 'guardian_email_required' | 'guardian_email_invalid',
): never {
  throw new ProblemError(
    status === 'guardian_email_required' ? 'GUARDIAN_EMAIL_REQUIRED' : 'GUARDIAN_EMAIL_INVALID',
  );
}

export function parentalRoutes(router: Router<Context>): void {
  router.route({
    method: 'POST',
    path: '/api/v1/me/parental-consent/resend',
    operation_id: 'resendParentalConsent',
    summary: 'Email the parent or guardian again',
    tags: ['account'],
    auth: 'session',
    allow_account_states: ['pending_parental_consent'],
    allow_pending_parental_consent: true,
    rate_limit: 'magic_link',
    responses: {
      202: {
        description: 'A new email is on its way',
        schema: consentSchema,
      },
    },
    errors: ['ACCOUNT_STATE_CONFLICT'],
    handler: async ({ ctx, identity, request, log }) => {
      const { userId } = signedIn(identity);
      const result = await resendParentalConsent({ ctx, request, log, identity }, { userId });
      if (result.status !== 'ok') throw new ProblemError('ACCOUNT_STATE_CONFLICT');
      const consent = await pendingParentalConsent(ctx, userId);
      if (consent === null) throw new ProblemError('ACCOUNT_STATE_CONFLICT');
      return { status: 202, headers: NO_STORE, body: consent };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/parental-consent/email',
    operation_id: 'changeGuardianEmail',
    summary: 'Change the parent or guardian email while waiting for approval',
    tags: ['account'],
    auth: 'session',
    allow_account_states: ['pending_parental_consent'],
    allow_pending_parental_consent: true,
    rate_limit: 'magic_link',
    request: { body: z.object({ email: z.email().max(254) }) },
    responses: {
      202: {
        description: 'The new address has been emailed',
        schema: consentSchema,
      },
    },
    errors: [
      'GUARDIAN_EMAIL_INVALID',
      'GUARDIAN_EMAIL_UNCHANGED',
      'GUARDIAN_EMAIL_CHANGE_LIMIT',
      'ACCOUNT_STATE_CONFLICT',
    ],
    handler: async ({ ctx, identity, body, request, log }) => {
      const { userId } = signedIn(identity);
      const result = await updateGuardianEmail(
        { ctx, request, log, identity },
        { userId, email: body.email },
      );
      switch (result.status) {
        case 'not_pending':
          throw new ProblemError('ACCOUNT_STATE_CONFLICT');
        case 'unchanged':
          throw new ProblemError('GUARDIAN_EMAIL_UNCHANGED');
        case 'limit':
          throw new ProblemError('GUARDIAN_EMAIL_CHANGE_LIMIT');
        case 'invalid':
          throw new ProblemError('GUARDIAN_EMAIL_INVALID');
        case 'ok': {
          const consent = await pendingParentalConsent(ctx, userId);
          if (consent === null) throw new ProblemError('ACCOUNT_STATE_CONFLICT');
          return { status: 202, headers: NO_STORE, body: consent };
        }
      }
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/parental-consent/approve',
    operation_id: 'approveParentalConsent',
    summary: 'Approve a child account as a parent or guardian',
    description:
      'The guardian confirms they are an adult and accepts the current legal documents on the child’s behalf.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: {
      body: tokenBody.extend({
        date_of_birth: z.iso
          .date()
          .refine((value) => isValidDateOfBirth(value, new Date()), 'Must be a real date of birth')
          .describe('The guardian’s date of birth, YYYY-MM-DD.'),
      }),
    },
    responses: { 204: { description: 'The account is now active' } },
    errors: ['GUARDIAN_CONSENT_INVALID', 'GUARDIAN_NOT_ADULT'],
    handler: async ({ ctx, body, request, log, identity }) => {
      const result = await grantParentalConsent(
        { ctx, request, log, identity },
        { token: body.token, dateOfBirth: body.date_of_birth },
      );
      if (result.status === 'not_adult') throw new ProblemError('GUARDIAN_NOT_ADULT');
      if (result.status !== 'ok') throw new ProblemError('GUARDIAN_CONSENT_INVALID');
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/parental-consent/decline',
    operation_id: 'declineParentalConsent',
    summary: 'Decline a child account as a parent or guardian',
    description: 'The unapproved account is deleted immediately.',
    tags: ['auth'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: { body: tokenBody },
    responses: { 204: { description: 'The account has been deleted' } },
    errors: ['GUARDIAN_CONSENT_INVALID'],
    handler: async ({ ctx, body, request, log, identity }) => {
      const result = await refuseParentalConsent(
        { ctx, request, log, identity },
        { token: body.token },
      );
      if (result.status !== 'ok') throw new ProblemError('GUARDIAN_CONSENT_INVALID');
      return { status: 204, headers: NO_STORE };
    },
  });
}
