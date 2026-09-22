import * as z from 'zod';

import { ACCOUNT_STATES, AGE_BANDS, parentalControlsSchema } from './identity.ts';

export const USER_CLAIMS_SERVICE = 'identity';
export const USER_CLAIMS_METHOD = 'user_claims';

export const AGE_ASSURANCE_STRENGTHS = ['self_declared', 'estimated', 'verified'] as const;
export type AgeAssuranceStrength = (typeof AGE_ASSURANCE_STRENGTHS)[number];

export const userClaimsRequestSchema = z.strictObject({
  user_id: z.uuid(),
});

export const userClaimsSchema = z.strictObject({
  id: z.uuid(),
  email: z.string().min(1),
  email_verified: z.boolean(),
  username: z.string().min(1).nullable(),
  username_updated_at: z.iso.datetime().nullable(),
  account_state: z.enum(ACCOUNT_STATES),
  age_band: z.enum(AGE_BANDS),
  age_assurance_strength: z.enum(AGE_ASSURANCE_STRENGTHS).nullable(),
  has_guardians: z.boolean(),
  parental_controls: parentalControlsSchema.nullable(),
  restrictions: z.array(z.string().min(1)),
});

export const userClaimsResponseSchema = z.strictObject({
  user: userClaimsSchema.nullable(),
});

export type UserClaimsRequest = z.output<typeof userClaimsRequestSchema>;
export type UserClaims = z.output<typeof userClaimsSchema>;
export type UserClaimsResponse = z.output<typeof userClaimsResponseSchema>;
