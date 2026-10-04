import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy, newNonce, shellHtml, shellResponse } from './shell.ts';

const config = {
  branding: {
    product_name: 'Example',
    company_name: 'Example Ltd',
    support_email: 'support@example.test',
    logo: null,
    colors: {
      primary: '#3b82f6',
      accent: '#BC6DE0',
      success: '#80D35D',
      warning: '#F7DA47',
      danger: '#DD5F5F',
      text: '#222034',
      text_muted: '#666577',
      bg: '#ffffff',
      bg_secondary: '#f5f5f7',
      border: '#d1d1d6',
      gradient_from: '#5BB1EF',
      gradient_to: '#BC6DE0',
    },
    backgrounds: { auth_light: null, auth_dark: null },
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
} as unknown as Parameters<typeof shellResponse>[0];

const baseInput = {
  product_name: 'Example',
  locale: 'en-GB',
  base_path: '/',
  meta_origin: undefined,
  nonce: 'n1',
  content: '<p>Hello</p>',
  theme: undefined,
} as const;

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
    const html = shellHtml({ ...baseInput });
    expect(html).toContain('<html lang="en-GB"');
    expect(html).toContain('class="qtiauth-skip-link"');
    expect(html).toContain('id="qtiauth-main"');
    expect(html).toContain('aria-live="polite"');
  });

  it('threads the base path into asset links', () => {
    const html = shellHtml({ ...baseInput, base_path: '/app' });
    expect(html).toContain('href="/app/theme.css"');
    expect(html).toContain('src="/app/app.js"');
  });

  it('escapes the product name so control characters in branding cannot inject markup', () => {
    const html = shellHtml({ ...baseInput, product_name: 'Example <script>' });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('Example &lt;script&gt;');
  });

  it('injects the pre-rendered page content into the main region', () => {
    const html = shellHtml({ ...baseInput, content: '<section id="probe">x</section>' });
    expect(html).toContain('<section id="probe">x</section>');
  });

  it('sets data-theme on <html> when a theme cookie is pinned', () => {
    expect(shellHtml({ ...baseInput, theme: 'dark' })).toContain('data-theme="dark"');
    expect(shellHtml({ ...baseInput, theme: 'light' })).toContain('data-theme="light"');
  });

  it('omits data-theme when the theme is unset so prefers-color-scheme wins', () => {
    expect(shellHtml({ ...baseInput, theme: undefined })).not.toContain('data-theme=');
  });
});

describe('shellResponse', () => {
  const options = {
    basePath: '/',
    metaOrigin: undefined,
    content: '<p>Hello</p>',
    locale: 'en-GB',
    theme: undefined,
  } as const;

  it('sends no-store and a strict CSP with a fresh nonce every response', async () => {
    const first = shellResponse(config, options);
    const second = shellResponse(config, options);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('x-frame-options')).toBe('DENY');
    const csp1 = first.headers.get('content-security-policy') ?? '';
    const csp2 = second.headers.get('content-security-policy') ?? '';
    expect(csp1).not.toBe(csp2);
    expect(await first.text()).toContain('id="qtiauth-app"');
  });
});
