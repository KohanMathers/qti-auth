import { createHash } from 'node:crypto';

import * as z from 'zod';

import { ACCOUNT_STATES, AGE_BANDS, parentalControlsSchema } from './identity.ts';

export const RESOLVE_SESSION_SERVICE = 'identity';
export const RESOLVE_SESSION_METHOD = 'resolve_session';

export const SESSION_TOKEN_HASH = /^[A-Za-z0-9_-]{43}$/;

export const resolveSessionRequestSchema = z.strictObject({
  binding_token_hash: z.string().regex(SESSION_TOKEN_HASH),
  cookie_scope: z.string().max(253),
});

export const resolvedSessionSchema = z.strictObject({
  session_id: z.string().min(1),
  user_id: z.string().min(1),
  account_state: z.enum(ACCOUNT_STATES),
  permissions: z.array(z.string().min(1)),
  restrictions: z.array(z.string().min(1)),
  age_band: z.enum(AGE_BANDS).nullable(),
  parental_controls: parentalControlsSchema.nullable(),
  amr: z.array(z.string().min(1)),
  acr: z.string().min(1).nullable(),
  step_up_at: z.iso.datetime().nullable(),
  legal_acceptance_required: z.boolean(),
  two_factor_enrolment_required: z.boolean(),
  expires_at: z.iso.datetime(),
});

export const resolveSessionResponseSchema = z.strictObject({
  session: resolvedSessionSchema.nullable(),
});

export type ResolveSessionRequest = z.output<typeof resolveSessionRequestSchema>;
export type ResolvedSession = z.output<typeof resolvedSessionSchema>;
export type ResolveSessionResponse = z.output<typeof resolveSessionResponseSchema>;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
