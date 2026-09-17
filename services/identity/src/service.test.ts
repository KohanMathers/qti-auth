import { sections } from '@qtiauth/config';
import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { definition, router } from './service.ts';

describe('identity service', () => {
  it('ships migrations for the identity schema, starting with the bus tables', async () => {
    expect(definition.database.schema).toBe('identity');
    const migrations = await definition.database.migrations();
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_bus_tables',
      '0002_users',
      '0003_sessions',
      '0004_email_tokens',
      '0005_passwords',
      '0006_captcha',
    ]);
  });

  it('declares every route with a policy the gateway knows', () => {
    const policies = Object.keys(sections.rate_limits.parse({}));
    const { routes } = router.manifest();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/v1/sessions/:session_id',
      'GET /api/v1/captcha',
      'GET /api/v1/me',
      'GET /api/v1/sessions',
      'GET /auth/forgot-password',
      'GET /auth/login',
      'GET /auth/magic-link',
      'GET /auth/magic-link/start',
      'GET /auth/register',
      'GET /auth/reset-password',
      'GET /auth/signup',
      'GET /auth/verify-email',
      'POST /api/v1/auth/email/verify',
      'POST /api/v1/auth/email/verify/start',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/magic-link/signup',
      'POST /api/v1/auth/magic-link/start',
      'POST /api/v1/auth/magic-link/verify',
      'POST /api/v1/auth/password/forgot',
      'POST /api/v1/auth/password/login',
      'POST /api/v1/auth/password/reset',
      'POST /api/v1/auth/password/signup',
      'POST /api/v1/me/password',
      'POST /api/v1/sessions/revoke-all',
      'POST /api/v1/sessions/revoke-others',
      'POST /auth/forgot-password',
      'POST /auth/login',
      'POST /auth/magic-link',
      'POST /auth/magic-link/start',
      'POST /auth/register',
      'POST /auth/reset-password',
      'POST /auth/signup',
      'POST /auth/verify-email',
    ]);
    for (const route of routes) {
      expect(policies, `${route.method} ${route.path}`).toContain(route.rate_limit);
      expect(route.module).toBe('core');
    }
  });

  it('rate-limits magic links by address and IP, and lets anyone sign out', () => {
    const route = (method: string, path: string) =>
      router.manifest().routes.find((r) => r.method === method && r.path === path);
    expect(route('POST', '/api/v1/auth/magic-link/start')).toMatchObject({
      auth: 'none',
      rate_limit: 'magic_link',
    });
    expect(route('POST', '/api/v1/auth/magic-link/verify')).toMatchObject({
      auth: 'none',
      rate_limit: 'auth_verify',
    });
    expect(route('POST', '/api/v1/auth/logout')).toMatchObject({
      auth: 'session',
      allow_pending_legal: true,
      allow_pending_parental_consent: true,
      allow_account_states: expect.arrayContaining(['active', 'banned', 'locked']) as unknown,
    });
    expect(route('POST', '/api/v1/auth/password/login')).toMatchObject({
      auth: 'none',
      rate_limit: 'auth_password',
    });
    expect(route('GET', '/api/v1/captcha')).toMatchObject({
      auth: 'none',
      rate_limit: 'global',
    });
    expect(route('POST', '/api/v1/auth/password/forgot')).toMatchObject({
      rate_limit: 'magic_link',
    });
    expect(route('POST', '/api/v1/me/password')).toMatchObject({
      auth: 'session',
      rate_limit: 'global',
    });
    expect(route('GET', '/api/v1/sessions')).toMatchObject({
      auth: 'session',
      allow_account_states: ['active'],
    });
  });

  it('lists its error codes in OpenAPI', () => {
    const document = openApiDocument(router) as {
      'x-qtiauth-errors': { code: string }[];
      paths: Record<string, unknown>;
    };
    expect(document['x-qtiauth-errors'].map((error) => error.code)).toEqual(
      expect.arrayContaining([
        'MAGIC_LINK_INVALID',
        'ACCOUNT_LIMIT_REACHED',
        'SESSION_NOT_FOUND',
        'CREDENTIALS_INCORRECT',
        'PASSWORD_REJECTED',
        'CAPTCHA_REQUIRED',
      ]),
    );
    expect(JSON.stringify(document.paths['/api/v1/auth/magic-link/signup'])).toContain(
      'PARENTAL_CONSENT_UNAVAILABLE',
    );
  });
});
