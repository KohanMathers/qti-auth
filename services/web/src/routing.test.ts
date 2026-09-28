import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

interface RouterModule {
  availableRoutes: (
    features: unknown,
    current: string,
  ) => { id: string; cross_surface: boolean; href: string }[];
  surfaceHref: (features: unknown, from: string, to: string, path: string) => string;
  translator: (catalogue: Record<string, string>) => (key: string, fallback?: string) => string;
}

const app = (await import(
  pathToFileURL(new URL('./assets/app.js', import.meta.url).pathname).toString()
)) as RouterModule;

const features = {
  branding: {
    product_name: 'Example',
    company_name: 'Example Ltd',
    support_email: 'support@example.test',
    colors: { primary: '#3b82f6' },
  },
  modules: { identity: true, oidc: true, games: true, support: true, safety: true, admin: true },
  auth: {
    methods: { password: true, magic_link: false, passkeys: true, totp: false },
    social: [{ id: 'google', name: 'Google', icon: null }],
    session_security: true,
  },
  features: { oidc: {}, games: {}, support: {} },
  surfaces: [
    {
      name: 'account',
      origins: ['https://account.example.test'],
      base_path: '/',
      modules: ['identity', 'oidc', 'games'],
    },
    {
      name: 'support',
      origins: ['https://support.example.test'],
      base_path: '/support',
      modules: ['support'],
    },
  ],
  surface_pairs: [{ surfaces: ['account', 'support'], same_site: false }],
};

describe('availableRoutes', () => {
  it('exposes an app route for every module the deployment ships', () => {
    const routes = app.availableRoutes(features, 'account');
    expect(routes.map((route) => route.id).sort()).toEqual([
      'account',
      'admin',
      'apps',
      'games',
      'sign-in',
      'support',
    ]);
  });

  it('skips modules that are not enabled', () => {
    const routes = app.availableRoutes(
      { ...features, modules: { ...features.modules, oidc: false, games: false, support: false } },
      'account',
    );
    expect(routes.some((route) => route.id === 'apps')).toBe(false);
    expect(routes.some((route) => route.id === 'games')).toBe(false);
    expect(routes.some((route) => route.id === 'support')).toBe(false);
  });

  it('does not offer sign-in when no interactive auth method is enabled', () => {
    const routes = app.availableRoutes(
      {
        ...features,
        auth: {
          ...features.auth,
          methods: { password: false, magic_link: false, passkeys: false, totp: false },
        },
      },
      'account',
    );
    expect(routes.some((route) => route.id === 'sign-in')).toBe(false);
  });

  it('marks routes that live on a different surface than the current one', () => {
    const routes = app.availableRoutes(features, 'account');
    const support = routes.find((route) => route.id === 'support');
    expect(support?.cross_surface).toBe(true);
    expect(support?.href.startsWith('https://')).toBe(true);
  });
});

describe('surfaceHref', () => {
  it('keeps the path relative when the current and target surface share a site', () => {
    const same = {
      ...features,
      surface_pairs: [{ surfaces: ['account', 'support'], same_site: true }],
    };
    expect(app.surfaceHref(same, 'account', 'support', '/tickets')).toBe('/support/tickets');
  });

  it('links out to the other origin when the surfaces are cross-site', () => {
    expect(app.surfaceHref(features, 'account', 'support', '/tickets')).toBe(
      'https://support.example.test/support/tickets',
    );
  });

  it('leaves same-surface paths untouched', () => {
    expect(app.surfaceHref(features, 'account', 'account', '/account')).toBe('/account');
  });
});

describe('translator', () => {
  it('reads translations from the catalogue', () => {
    const t = app.translator({ 'nav.sign-in': 'Mewngofnodi' });
    expect(t('nav.sign-in', 'Sign in')).toBe('Mewngofnodi');
  });

  it('falls back to the given English string when the key is missing', () => {
    const t = app.translator({});
    expect(t('nav.sign-in', 'Sign in')).toBe('Sign in');
  });
});
