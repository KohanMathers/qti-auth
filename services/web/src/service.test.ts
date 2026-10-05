import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { PAGES } from './assets/pages.js';
import { router } from './service.ts';

describe('web service', () => {
  it('announces a route for every page path plus the static assets and preference endpoints', () => {
    const { routes } = router.manifest();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [
        'GET /',
        'GET /app.js',
        'GET /captcha.js',
        'GET /client.js',
        'GET /locales/:locale',
        'GET /pages.js',
        'GET /problems.js',
        'GET /styles.css',
        'GET /templates.html',
        'GET /theme.css',
        'GET /view.js',
        'POST /locale',
        'POST /theme',
        ...Object.values(PAGES)
          .filter((page) => page.path !== '/')
          .map((page) => `GET ${page.path}`),
      ].sort(),
    );
    expect(routes.every((route) => route.module === 'core')).toBe(true);
    expect(routes.every((route) => route.auth === 'none')).toBe(true);
  });

  it('exposes an OpenAPI document that lists every web endpoint', () => {
    const document = openApiDocument(router) as { paths: Record<string, unknown> };
    expect(document.paths['/']).toBeDefined();
    expect(document.paths['/theme.css']).toBeDefined();
    expect(document.paths['/locales/{locale}']).toBeDefined();
    expect(document.paths['/sign-in']).toBeDefined();
    expect(document.paths['/family/{id}']).toBeDefined();
    expect(document.paths['/theme']).toBeDefined();
  });
});
