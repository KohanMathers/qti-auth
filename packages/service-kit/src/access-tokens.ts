import * as z from 'zod';

import { ACCOUNT_STATES, AGE_BANDS, parentalControlsSchema } from './identity.ts';

export const RESOLVE_ACCESS_TOKEN_SERVICE = 'oidc';
export const RESOLVE_ACCESS_TOKEN_METHOD = 'resolve_access_token';

export const resolveAccessTokenRequestSchema = z.strictObject({
  token: z.string().min(1).max(8192),
});

export const resolvedAccessTokenSchema = z.strictObject({
  jti: z.string().min(1),
  sub: z.string().min(1),
  client_id: z.string().min(1),
  scopes: z.array(z.string().min(1)),
  sid: z.string().min(1).nullable(),
  account_state: z.enum(ACCOUNT_STATES),
  restrictions: z.array(z.string().min(1)),
  age_band: z.enum(AGE_BANDS).nullable(),
  parental_controls: parentalControlsSchema.nullable(),
  amr: z.array(z.string().min(1)),
  acr: z.string().min(1).nullable(),
});

export const resolveAccessTokenResponseSchema = z.strictObject({
  token: resolvedAccessTokenSchema.nullable(),
});

export type ResolveAccessTokenRequest = z.output<typeof resolveAccessTokenRequestSchema>;
export type ResolvedAccessToken = z.output<typeof resolvedAccessTokenSchema>;
export type ResolveAccessTokenResponse = z.output<typeof resolveAccessTokenResponseSchema>;
