import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { router } from './service.ts';

describe('web service', () => {
  it('announces the shell, theme, script and locale routes on the core module', () => {
    const { routes } = router.manifest();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'GET /',
      'GET /app.js',
      'GET /client.js',
      'GET /locales/:locale',
      'GET /pages.js',
      'GET /problems.js',
      'GET /styles.css',
      'GET /theme.css',
    ]);
    expect(routes.every((route) => route.module === 'core')).toBe(true);
    expect(routes.every((route) => route.auth === 'none')).toBe(true);
  });

  it('exposes an OpenAPI document that lists every web endpoint', () => {
    const document = openApiDocument(router) as { paths: Record<string, unknown> };
    expect(document.paths['/']).toBeDefined();
    expect(document.paths['/theme.css']).toBeDefined();
    expect(document.paths['/locales/{locale}']).toBeDefined();
  });
});
