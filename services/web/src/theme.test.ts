import { describe, expect, it } from 'vitest';

import { themeCss, themeResponse, ThemeError } from './theme.ts';

const config = {
  branding: {
    product_name: 'Example',
    company_name: 'Example Ltd',
    support_email: 'support@example.test',
    logo: null,
    colors: { primary: '#3b82f6' },
  },
};

describe('themeCss', () => {
  it('exposes the primary colour as a CSS custom property under :root', () => {
    const css = themeCss(config);
    expect(css).toContain('--qtiauth-color-primary: #3b82f6;');
    expect(css).toContain(':root');
  });

  it('defines a dark colour scheme via prefers-color-scheme', () => {
    const css = themeCss(config);
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  it('rejects a primary that is not a hex colour', () => {
    expect(() =>
      themeCss({ branding: { ...config.branding, colors: { primary: 'blue' } } }),
    ).toThrow(ThemeError);
  });

  it('accepts three, six and eight digit hex colours', () => {
    for (const primary of ['#fff', '#ffffff', '#ffffff00']) {
      expect(() =>
        themeCss({ branding: { ...config.branding, colors: { primary } } }),
      ).not.toThrow();
    }
  });
});

describe('themeResponse', () => {
  it('serves the stylesheet as text/css with a public cache header', () => {
    const response = themeResponse(config);
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(response.headers.get('cache-control')).toContain('public');
  });
});
