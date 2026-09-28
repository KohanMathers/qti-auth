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
  it("locks scripts down to 'none' when a page has no scripts", () => {
    expect(contentSecurityPolicy(undefined)).toContain("script-src 'none'");
    expect(contentSecurityPolicy(undefined)).toContain("default-src 'none'");
    expect(contentSecurityPolicy(undefined)).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy(undefined)).toContain("form-action 'self'");
    expect(contentSecurityPolicy(undefined)).toContain("base-uri 'none'");
  });

  it('threads the nonce and external sources into script-src', () => {
    const csp = contentSecurityPolicy({
      nonce: 'abc',
      sources: ['https://challenges.cloudflare.com/turnstile/v0/api.js'],
    });
    expect(csp).toContain(
      "script-src 'nonce-abc' https://challenges.cloudflare.com/turnstile/v0/api.js",
    );
  });
});

describe('htmlResponse', () => {
  it('sets the strict CSP, no-store cache and content-type on every page', async () => {
    const response = htmlResponse({ title: 'Hello', product: 'Example', body: '<p>Hi</p>' });
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const csp = response.headers.get('content-security-policy');
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    const body = await response.text();
    expect(body).toContain('<title>Hello · Example</title>');
    expect(body).toContain('<p>Hi</p>');
  });

  it('lets a page carry an inline script under its nonce', () => {
    const response = htmlResponse({
      title: 'With CAPTCHA',
      product: 'Example',
      body: '<script nonce="n1">/* … */</script>',
      scripts: { nonce: 'n1' },
    });
    expect(response.headers.get('content-security-policy')).toContain("script-src 'nonce-n1'");
  });
});
