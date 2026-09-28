import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy, newNonce, shellHtml, shellResponse } from './shell.ts';

const config = {
  branding: {
    product_name: 'Example',
    company_name: 'Example Ltd',
    support_email: 'support@example.test',
    logo: null,
    colors: { primary: '#3b82f6' },
  },
  surfaces: {
    account: {
      hosts: ['account.example.test'],
      ports: [],
      base_path: '/',
      modules: null,
      origins: null,
    },
    support: {
      hosts: ['support.example.test'],
      ports: [],
      base_path: '/',
      modules: null,
      origins: null,
    },
    api: {
      hosts: ['api.example.test'],
      ports: [],
      base_path: '/api',
      modules: null,
      origins: null,
    },
  },
};

describe('newNonce', () => {
  it('returns a fresh base64 value each call', () => {
    expect(newNonce()).not.toBe(newNonce());
  });
});

describe('contentSecurityPolicy', () => {
  it('locks down default-src and allows only the nonced script', () => {
    const csp = contentSecurityPolicy('n1', undefined);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-n1'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('adds the meta origin to connect-src when features come from a different host', () => {
    const csp = contentSecurityPolicy('n1', 'https://api.example.test');
    expect(csp).toContain("connect-src 'self' https://api.example.test");
  });
});

describe('shellHtml', () => {
  it('sets the document language and skip link for accessibility', () => {
    const html = shellHtml({
      product_name: 'Example',
      locale: 'en-GB',
      base_path: '/',
      meta_origin: undefined,
      nonce: 'n1',
    });
    expect(html).toContain('<html lang="en-GB">');
    expect(html).toContain('class="qtiauth-skip-link"');
    expect(html).toContain('id="qtiauth-main"');
    expect(html).toContain('aria-live="polite"');
  });

  it('threads the base path into asset links', () => {
    const html = shellHtml({
      product_name: 'Example',
      locale: 'en-GB',
      base_path: '/app',
      meta_origin: undefined,
      nonce: 'n1',
    });
    expect(html).toContain('href="/app/theme.css"');
    expect(html).toContain('src="/app/app.js"');
  });

  it('escapes the product name so control characters in branding cannot inject markup', () => {
    const html = shellHtml({
      product_name: 'Example <script>',
      locale: 'en-GB',
      base_path: '/',
      meta_origin: undefined,
      nonce: 'n1',
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('Example &lt;script&gt;');
  });
});

describe('shellResponse', () => {
  it('sends no-store and a strict CSP with a fresh nonce every response', async () => {
    const first = shellResponse(config, { basePath: '/', metaOrigin: undefined });
    const second = shellResponse(config, { basePath: '/', metaOrigin: undefined });
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('x-frame-options')).toBe('DENY');
    const csp1 = first.headers.get('content-security-policy') ?? '';
    const csp2 = second.headers.get('content-security-policy') ?? '';
    expect(csp1).not.toBe(csp2);
    expect(await first.text()).toContain('id="qtiauth-app"');
  });
});
