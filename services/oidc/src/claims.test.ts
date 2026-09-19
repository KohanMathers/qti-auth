import { sections } from '@qtiauth/config';
import type { UserClaims } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { userinfoClaims } from './claims.ts';

const configured = sections.oidc.parse({}).scopes;

const user: UserClaims = {
  id: '0199a0e0-0000-7000-8000-000000000001',
  email: 'sam@example.com',
  email_verified: true,
  username: 'sam',
  username_updated_at: '2026-01-01T00:00:00.000Z',
  account_state: 'active',
  age_band: 'adult',
  age_assurance_strength: 'self_declared',
  parental_controls: null,
  restrictions: ['chat'],
};

describe('userinfoClaims', () => {
  it('always includes sub and only the claims the granted scopes release', () => {
    expect(userinfoClaims(user, ['openid'], configured)).toEqual({ sub: user.id });
    expect(userinfoClaims(user, ['openid', 'email', 'age'], configured)).toEqual({
      sub: user.id,
      email: 'sam@example.com',
      email_verified: true,
      age_band: 'adult',
      age_assurance_strength: 'self_declared',
    });
    expect(userinfoClaims(user, ['openid', 'profile', 'restrictions'], configured)).toMatchObject({
      preferred_username: 'sam',
      restrictions: ['chat'],
    });
  });
});
