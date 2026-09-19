import { sections } from '@qtiauth/config';
import { openApiDocument } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { definition, router } from './service.ts';

describe('oidc service', () => {
  it('ships migrations for the oidc schema, starting with the bus tables', async () => {
    expect(definition.database.schema).toBe('oidc');
    const migrations = await definition.database.migrations();
    expect(migrations.map((migration) => migration.name)).toEqual([
      '0001_bus_tables',
      '0002_oidc',
      '0003_grants',
      '0004_logout',
      '0005_portal',
    ]);
  });

  it('declares every route with a policy the gateway knows', () => {
    const policies = Object.keys(sections.rate_limits.parse({}));
    const { routes } = router.manifest();
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      'DELETE /api/v1/oauth/authorized/:client_id',
      'DELETE /api/v1/oauth/clients/:client_id',
      'GET /.well-known/jwks.json',
      'GET /.well-known/openid-configuration',
      'GET /api/v1/oauth/authorized',
      'GET /api/v1/oauth/client',
      'GET /api/v1/oauth/clients',
      'GET /api/v1/oauth/clients/:client_id',
      'GET /oauth/authorize',
      'GET /oauth/consent',
      'GET /oauth/device',
      'GET /oauth/userinfo',
      'PATCH /api/v1/oauth/clients/:client_id',
      'POST /api/v1/admin/oauth/clients/:client_id/suspend',
      'POST /api/v1/admin/oauth/clients/:client_id/unsuspend',
      'POST /api/v1/admin/oauth/clients/:client_id/verify',
      'POST /api/v1/oauth/clients',
      'POST /api/v1/oauth/clients/:client_id/secret',
      'POST /oauth/consent',
      'POST /oauth/device',
      'POST /oauth/device_authorization',
      'POST /oauth/introspect',
      'POST /oauth/par',
      'POST /oauth/revoke',
      'POST /oauth/token',
    ]);
    for (const route of routes) {
      expect(policies, route.path).toContain(route.rate_limit);
    }
    expect(
      router
        .manifest()
        .permissions.map((permission) => permission.name)
        .sort(),
    ).toEqual(['oidc.clients.suspend', 'oidc.clients.verify']);
  });

  it('protects the protocol endpoints the way the spec requires', () => {
    const route = (method: string, path: string) =>
      router.manifest().routes.find((entry) => entry.method === method && entry.path === path);

    expect(route('GET', '/oauth/authorize')).toMatchObject({
      auth: 'session',
      module: 'oidc',
      rate_limit: 'oauth_authorize',
    });
    expect(route('GET', '/oauth/consent')).toMatchObject({ auth: 'session' });
    expect(route('POST', '/oauth/token')).toMatchObject({
      auth: 'none',
      rate_limit: 'oauth_token',
    });
    expect(route('GET', '/oauth/userinfo')).toMatchObject({
      auth: 'oauth',
      scopes: ['openid'],
    });
    expect(route('POST', '/oauth/device_authorization')).toMatchObject({ auth: 'none' });
    expect(route('GET', '/oauth/device')).toMatchObject({ auth: 'session' });
    expect(route('POST', '/oauth/par')).toMatchObject({ auth: 'none' });
    expect(route('GET', '/api/v1/oauth/client')).toMatchObject({ auth: 'service' });
    expect(route('GET', '/.well-known/openid-configuration')).toMatchObject({ auth: 'none' });
    expect(route('GET', '/api/v1/oauth/authorized')).toMatchObject({ auth: 'session' });
    expect(route('POST', '/api/v1/oauth/clients')).toMatchObject({ auth: 'session' });
    expect(route('POST', '/api/v1/oauth/clients/:client_id/secret')).toMatchObject({
      auth: 'session',
      step_up: true,
    });
    expect(route('POST', '/api/v1/admin/oauth/clients/:client_id/verify')).toMatchObject({
      auth: 'session',
      permissions: ['oidc.clients.verify'],
    });
    expect(route('POST', '/api/v1/admin/oauth/clients/:client_id/suspend')).toMatchObject({
      auth: 'session',
      permissions: ['oidc.clients.suspend'],
    });
    expect(route('POST', '/api/v1/admin/oauth/clients/:client_id/unsuspend')).toMatchObject({
      auth: 'session',
      permissions: ['oidc.clients.suspend'],
    });
  });

  it('lists its error codes in OpenAPI', () => {
    const document = openApiDocument(router) as { 'x-qtiauth-errors': { code: string }[] };
    expect(document['x-qtiauth-errors'].map((error) => error.code)).toEqual(
      expect.arrayContaining([
        'CLIENT_NOT_FOUND',
        'AUTHORIZATION_INVALID',
        'DEVELOPER_PORTAL_DISABLED',
        'CLIENT_CHILD_ACCOUNT',
        'CLIENT_LIMIT_REACHED',
        'CLIENT_NAME_REJECTED',
      ]),
    );
  });
});
