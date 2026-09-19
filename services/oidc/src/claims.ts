import type { UserClaims } from '@qtiauth/service-kit';

import type { ScopeConfig } from './scopes.ts';
import { claimsFor } from './scopes.ts';

export type ClaimSet = Record<string, unknown>;

export function userinfoClaims(
  user: UserClaims,
  scopes: readonly string[],
  configured: ScopeConfig,
): ClaimSet {
  const released = new Set(claimsFor(scopes, configured));
  const claims: ClaimSet = { sub: user.id };
  if (released.has('preferred_username') && user.username !== null) {
    claims['preferred_username'] = user.username;
  }
  if (released.has('username_updated_at') && user.username_updated_at !== null) {
    claims['username_updated_at'] = user.username_updated_at;
  }
  if (released.has('email')) claims['email'] = user.email;
  if (released.has('email_verified')) claims['email_verified'] = user.email_verified;
  if (released.has('age_band')) claims['age_band'] = user.age_band;
  if (released.has('age_assurance_strength')) {
    claims['age_assurance_strength'] = user.age_assurance_strength;
  }
  if (released.has('parental_controls')) claims['parental_controls'] = user.parental_controls;
  if (released.has('restrictions')) claims['restrictions'] = user.restrictions;
  return claims;
}
