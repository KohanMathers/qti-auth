import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import {
  accountOrigin,
  accountPath,
  IdentityConfigError,
  magicLinkUrl,
  sessionClient,
} from './settings.ts';

function surfaces(account: Record<string, unknown>) {
  return {
    surfaces: sections.surfaces.parse({ account, support: { hosts: ['help.example.com'] } }),
  };
}

describe('magic link URLs', () => {
  it('point at the account surface’s first origin and base path', () => {
    expect(magicLinkUrl(surfaces({ hosts: ['me.example.com'] }), 'abc')).toBe(
      'https://me.example.com/auth/magic-link?token=abc',
    );
    expect(
      magicLinkUrl(
        surfaces({ ports: [8080], base_path: '/account', origins: ['http://10.0.0.5:8080'] }),
        'abc',
      ),
    ).toBe('http://10.0.0.5:8080/account/auth/magic-link?token=abc');
    expect(accountPath(surfaces({ hosts: ['me.example.com'] }), '/settings')).toBe('/settings');
  });

  it('need an origin for an account surface bound only to ports', () => {
    expect(() => accountOrigin(surfaces({ ports: [8080] }))).toThrow(IdentityConfigError);
  });
});

describe('sessionClient', () => {
  it('binds to the shared cookie domain, or the host the gateway saw', () => {
    const request = new Request('http://identity:8080/', {
      headers: { 'x-forwarded-host': 'me.example.com', 'user-agent': 'Firefox' },
    });
    expect(sessionClient({ cookies: sections.cookies.parse({}) }, request)).toEqual({
      userAgent: 'Firefox',
      cookieScope: 'me.example.com',
    });
    expect(
      sessionClient({ cookies: sections.cookies.parse({ domain: 'example.com' }) }, request)
        .cookieScope,
    ).toBe('example.com');
  });
});
