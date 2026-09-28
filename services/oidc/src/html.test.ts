import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy, htmlResponse, newNonce } from './html.ts';

describe('newNonce', () => {
  it('returns a fresh base64 value each call', () => {
    const one = newNonce();
    const two = newNonce();
    expect(one).not.toBe(two);
    expect(one).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe('contentSecurityPolicy', () => {
  it("locks scripts down to 'none' by default", () => {
    expect(contentSecurityPolicy(undefined)).toContain("script-src 'none'");
    expect(contentSecurityPolicy(undefined)).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy(undefined)).toContain("base-uri 'none'");
  });

  it('threads the nonce into script-src', () => {
    expect(contentSecurityPolicy({ nonce: 'abc' })).toContain("script-src 'nonce-abc'");
  });
});

describe('htmlResponse', () => {
  it('sets the strict CSP and no-store cache on every page', () => {
    const response = htmlResponse({ title: 'Consent', product: 'Example', body: '<p>Hi</p>' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
  });
});
