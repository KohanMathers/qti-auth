import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import {
  claimsFor,
  includesOfflineAccess,
  missingConsent,
  parseScopeString,
  requestedScopes,
} from './scopes.ts';

const configured = sections.oidc.parse({}).scopes;

describe('scopes', () => {
  it('parses a unique space-separated list', () => {
    expect(parseScopeString('openid profile')).toEqual(['openid', 'profile']);
    expect(parseScopeString('openid+profile')).toEqual(['openid', 'profile']);
    expect(parseScopeString('openid openid')).toBeUndefined();
    expect(parseScopeString('')).toBeUndefined();
  });

  it('rejects unknown or disallowed scopes', () => {
    expect(requestedScopes(['openid', 'email'], configured, null)).toEqual(['openid', 'email']);
    expect(requestedScopes(['openid', 'unknown'], configured, null)).toBeUndefined();
    expect(requestedScopes(['openid', 'email'], configured, ['openid'])).toBeUndefined();
  });

  it('lists the claims a set of scopes releases', () => {
    expect(claimsFor(['openid', 'email'], configured).sort()).toEqual(['email', 'email_verified']);
    expect(includesOfflineAccess(['openid', 'offline_access'])).toBe(true);
    expect(missingConsent(['openid', 'email'], ['openid'])).toEqual(['email']);
  });
});
