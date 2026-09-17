import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import {
  authorizationUrl,
  pkceChallenge,
  pkceVerifier,
  profileFromDiscord,
  profileFromGithub,
  profileFromOidc,
} from './oauth.ts';
import { findSocialProvider } from './providers.ts';

const social = sections.features.parse({
  auth: {
    social: {
      google: { enabled: true, client_id: 'g-id', client_secret: 'g-secret' },
      github: { enabled: true, client_id: 'gh-id', client_secret: 'gh-secret' },
      discord: { enabled: true, client_id: 'd-id', client_secret: 'd-secret' },
    },
  },
}).auth.social;

describe('oauth helpers', () => {
  it('builds a PKCE authorize URL', () => {
    const verifier = pkceVerifier();
    expect(verifier.length).toBeGreaterThan(20);
    const google = findSocialProvider(social, 'google');
    expect(google).toBeDefined();
    if (google === undefined) return;
    const url = new URL(
      authorizationUrl(google, {
        redirectUri: 'https://me.example.com/auth/social/google/callback',
        state: 'st',
        codeChallenge: pkceChallenge(verifier),
        nonce: 'n1',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe('n1');
    expect(url.searchParams.get('client_id')).toBe('g-id');
  });

  it('trusts only verified provider emails', () => {
    expect(
      profileFromOidc({
        sub: '1',
        email: 'sam@example.com',
        email_verified: true,
      }),
    ).toMatchObject({ email: 'sam@example.com', emailVerified: true });
    expect(profileFromOidc({ sub: '1', email: 'sam@example.com' })).toMatchObject({
      emailVerified: false,
    });
    expect(
      profileFromDiscord({ id: '9', email: 'sam@example.com', verified: false }),
    ).toMatchObject({
      emailVerified: false,
    });
    expect(
      profileFromGithub({ id: 12, login: 'sam' }, [
        { email: 'sam@example.com', primary: true, verified: false },
        { email: 'other@example.com', primary: false, verified: true },
      ]),
    ).toMatchObject({ email: 'other@example.com', emailVerified: true });
  });
});
