import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { applySecurityHeaders, hstsValue } from './headers.ts';

const hsts = hstsValue(sections.gateway.parse({}).hsts);

describe('hstsValue', () => {
  it('renders the configured policy', () => {
    expect(hsts).toBe('max-age=31536000');
    expect(
      hstsValue(
        sections.gateway.parse({ hsts: { max_age: '2d', include_subdomains: true, preload: true } })
          .hsts,
      ),
    ).toBe('max-age=172800; includeSubDomains; preload');
  });
});

describe('applySecurityHeaders', () => {
  it('sets the baseline headers and a locked-down CSP for API responses', () => {
    const headers = new Headers({ server: 'hono', 'x-powered-by': 'node' });
    applySecurityHeaders(headers, hsts);
    expect(Object.fromEntries(headers)).toEqual({
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy':
        'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
  });

  it("keeps a service's CSP but never lets it allow framing", () => {
    const headers = new Headers({
      'content-security-policy': "default-src 'self'; frame-ancestors https://evil.example.net",
    });
    applySecurityHeaders(headers, hsts);
    expect(headers.get('content-security-policy')).toBe(
      "default-src 'self'; frame-ancestors 'none'",
    );

    const kept = new Headers({
      'content-security-policy': "script-src 'nonce-abc'; frame-ancestors 'none'",
    });
    applySecurityHeaders(kept, hsts);
    expect(kept.get('content-security-policy')).toBe(
      "script-src 'nonce-abc'; frame-ancestors 'none'",
    );
  });
});
