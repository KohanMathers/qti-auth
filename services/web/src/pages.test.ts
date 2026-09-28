import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

interface PagesModule {
  PAGES: Record<string, { path: string; requires?: Record<string, boolean> }>;
  availablePages: (features: unknown) => { id: string; path: string }[];
  matchPage: (
    pages: { path: string }[],
    path: string,
  ) => { page: { path: string }; params: Record<string, string> } | null;
  pathMatch: (pattern: string, path: string) => Record<string, string> | null;
}

const pages = (await import(
  pathToFileURL(new URL('./assets/pages.js', import.meta.url).pathname).toString()
)) as PagesModule;

function baseFeatures(overrides: Record<string, unknown> = {}): unknown {
  return {
    branding: {
      product_name: 'Example',
      company_name: 'Example Ltd',
      colors: { primary: '#3b82f6' },
    },
    modules: {
      identity: true,
      oidc: true,
      games: true,
      support: true,
      safety: true,
      admin: true,
    },
    auth: {
      methods: { password: true, magic_link: true, passkeys: true, totp: true },
      social: [],
      session_security: true,
    },
    surfaces: [],
    surface_pairs: [],
    ...overrides,
  };
}

describe('pathMatch', () => {
  it('matches a static path with equal segments', () => {
    expect(pages.pathMatch('/account/security', '/account/security')).toEqual({});
  });

  it('captures a parameter segment', () => {
    expect(pages.pathMatch('/family/:id', '/family/abc123')).toEqual({ id: 'abc123' });
  });

  it('rejects paths of a different length', () => {
    expect(pages.pathMatch('/account', '/account/security')).toBeNull();
  });

  it('rejects a mismatched static segment', () => {
    expect(pages.pathMatch('/admin/users', '/admin/roles')).toBeNull();
  });

  it('decodes a percent-encoded parameter', () => {
    expect(pages.pathMatch('/family/:id', '/family/one%20two')).toEqual({ id: 'one two' });
  });
});

describe('availablePages', () => {
  it('drops identity pages when the identity module is off', () => {
    const list = pages.availablePages(
      baseFeatures({
        modules: {
          identity: false,
          oidc: true,
          games: true,
          support: true,
          safety: true,
          admin: false,
        },
      }),
    );
    const ids = list.map((page) => page.id);
    expect(ids).not.toContain('account');
    expect(ids).not.toContain('sessions');
    expect(ids).not.toContain('family');
  });

  it('drops the sign-in page when no interactive auth method is enabled', () => {
    const list = pages.availablePages(
      baseFeatures({
        auth: {
          methods: { password: false, magic_link: false, passkeys: false, totp: false },
          social: [],
        },
      }),
    );
    expect(list.some((page) => page.id === 'sign-in')).toBe(false);
  });

  it('drops the forgot page when password auth is not enabled', () => {
    const list = pages.availablePages(
      baseFeatures({
        auth: {
          methods: { password: false, magic_link: true, passkeys: true, totp: false },
          social: [],
        },
      }),
    );
    expect(list.some((page) => page.id === 'forgot')).toBe(false);
  });

  it('drops admin pages when the admin module is off', () => {
    const list = pages.availablePages(
      baseFeatures({
        modules: {
          identity: true,
          oidc: false,
          games: false,
          support: false,
          safety: false,
          admin: false,
        },
      }),
    );
    expect(list.some((page) => page.id.startsWith('admin'))).toBe(false);
  });

  it('exposes every page the roadmap milestone lists when every module is on', () => {
    const list = pages.availablePages(baseFeatures());
    const ids = new Set(list.map((page) => page.id));
    for (const expected of [
      'sign-in',
      'sign-up',
      'verify',
      'forgot',
      'reset',
      'account',
      'profile',
      'email',
      'security',
      'sessions',
      'methods',
      'notifications',
      'legal',
      'data',
      'family',
      'child',
      'waiting',
      'consent',
      'device',
      'apps',
      'developer',
      'games',
      'redeem',
      'achievements',
      'stats',
      'leaderboards',
      'devices',
      'report',
      'support',
      'support-kb',
      'support-kb-search',
      'support-kb-category',
      'support-kb-article',
      'support-tickets',
      'support-tickets-new',
      'support-ticket',
      'support-appeal',
      'support-guest',
      'support-guest-verify',
      'support-guest-view',
      'support-staff',
      'support-staff-tickets',
      'support-staff-ticket',
      'support-staff-macros',
      'support-staff-metrics',
      'support-staff-kb',
      'support-staff-kb-article',
      'admin',
      'admin-users',
      'admin-roles',
      'admin-audit',
      'admin-webhooks',
      'admin-filter',
      'admin-moderation',
      'admin-csea',
      'admin-oauth',
      'admin-games',
      'admin-health',
    ]) {
      expect(ids.has(expected)).toBe(true);
    }
  });

  it('drops support pages when the support module is off', () => {
    const list = pages.availablePages(
      baseFeatures({
        modules: {
          identity: true,
          oidc: true,
          games: true,
          support: false,
          safety: true,
          admin: true,
        },
      }),
    );
    expect(list.some((page) => page.id.startsWith('support'))).toBe(false);
  });

  it('drops staff support pages when the admin module is off', () => {
    const list = pages.availablePages(
      baseFeatures({
        modules: {
          identity: true,
          oidc: true,
          games: true,
          support: true,
          safety: true,
          admin: false,
        },
      }),
    );
    expect(list.some((page) => page.id.startsWith('support-staff'))).toBe(false);
    expect(list.some((page) => page.id === 'support-kb')).toBe(true);
  });
});

describe('matchPage', () => {
  it('finds a page for a nested static route', () => {
    const list = pages.availablePages(baseFeatures());
    const match = pages.matchPage(list, '/account/sessions');
    expect(match?.page.path).toBe('/account/sessions');
  });

  it('extracts a parameter from a matched page path', () => {
    const list = pages.availablePages(baseFeatures());
    const match = pages.matchPage(list, '/family/child-123');
    expect(match?.params).toEqual({ id: 'child-123' });
  });

  it('returns null when nothing matches', () => {
    const list = pages.availablePages(baseFeatures());
    expect(pages.matchPage(list, '/does-not-exist')).toBeNull();
  });
});
