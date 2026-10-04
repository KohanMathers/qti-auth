import { describe, expect, it } from 'vitest';

import { themeCss, themeResponse, ThemeError } from './theme.ts';

function brandingConfig(overrides: Record<string, string> = {}): Parameters<typeof themeCss>[0] {
  return {
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
        ...overrides,
      },
      backgrounds: { auth_light: null, auth_dark: null },
    },
  } as unknown as Parameters<typeof themeCss>[0];
}

describe('themeCss', () => {
  it('exposes the primary colour as a CSS custom property under :root', () => {
    const css = themeCss(brandingConfig());
    expect(css).toContain('--qtiauth-color-primary: #3b82f6;');
    expect(css).toContain('--qt-color-primary: #3b82f6;');
    expect(css).toContain(':root');
  });

  it('defines a dark colour scheme via prefers-color-scheme', () => {
    const css = themeCss(brandingConfig());
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  it('rejects a primary that is not a hex colour', () => {
    expect(() => themeCss(brandingConfig({ primary: 'blue' }))).toThrow(ThemeError);
  });

  it('accepts three, six and eight digit hex colours', () => {
    for (const primary of ['#fff', '#ffffff', '#ffffff00']) {
      expect(() => themeCss(brandingConfig({ primary }))).not.toThrow();
    }
  });
});

describe('themeResponse', () => {
  it('serves the stylesheet as text/css with a public cache header', () => {
    const response = themeResponse(brandingConfig());
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(response.headers.get('cache-control')).toContain('public');
  });
});
