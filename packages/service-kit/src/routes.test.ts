import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { defineNotificationCategories } from './notifications.ts';
import { definePermissions } from './permissions.ts';
import { defineErrors } from './problems.ts';
import { createRouter, impliedErrors, type Router, routeManifestSchema } from './routes.ts';

const permissions = definePermissions({ 'users.read': { description: 'Read users' } });
const errors = defineErrors({ USER_NOT_FOUND: { status: 404, title: 'User not found' } });

function router(): Router<undefined> {
  return createRouter<undefined>({
    service: 'identity',
    version: '1.2.3',
    module: 'core',
    permissions,
    errors,
  });
}

function define(r: Router<undefined>, overrides: object = {}): void {
  r.route({
    method: 'GET',
    path: '/api/v1/ping',
    operation_id: 'ping',
    summary: 'Ping',
    auth: 'session',
    rate_limit: 'global',
    responses: { 200: { description: 'OK', schema: z.object({ ok: z.boolean() }) } },
    handler: () => Promise.resolve({ status: 200 as const, body: { ok: true } }),
    ...overrides,
  } as never);
}

describe('createRouter', () => {
  it('applies the spec defaults to a route policy', () => {
    const r = router();
    define(r);
    expect(r.manifest()).toEqual({
      service: 'identity',
      version: '1.2.3',
      routes: [
        {
          method: 'GET',
          path: '/api/v1/ping',
          module: 'core',
          auth: 'session',
          permissions: [],
          scopes: [],
          allow_account_states: ['active'],
          allow_pending_legal: false,
          allow_pending_parental_consent: false,
          allow_pending_2fa_enrolment: false,
          allow_aal0: false,
          rate_limit: 'global',
          step_up: false,
        },
      ],
      permissions: [{ name: 'users.read', description: 'Read users', wildcard: true }],
      notifications: [],
    });
    expect(routeManifestSchema.safeParse(r.manifest()).success).toBe(true);
  });

  it('includes declared notification categories in the manifest', () => {
    const r = createRouter<undefined>({
      service: 'support',
      version: '1.0.0',
      module: 'support',
      notifications: defineNotificationCategories({
        'support.ticket_updates': { description: 'Ticket replies' },
        'identity.security': { description: 'Security emails', disableable: false },
      }),
    });
    expect(r.manifest().notifications).toEqual([
      {
        name: 'support.ticket_updates',
        description: 'Ticket replies',
        disableable: true,
        audience: 'user',
      },
      {
        name: 'identity.security',
        description: 'Security emails',
        disableable: false,
        audience: 'user',
      },
    ]);
  });

  it('keeps a declared policy', () => {
    const r = router();
    define(r, {
      path: '/api/v1/users/:user_id',
      operation_id: 'getUser',
      module: 'admin',
      permissions: ['users.read'],
      allow_account_states: ['active', 'locked'],
      allow_pending_legal: true,
      step_up: true,
      request: { params: z.object({ user_id: z.uuid() }) },
      errors: ['USER_NOT_FOUND'],
    });
    expect(r.manifest().routes[0]).toMatchObject({
      module: 'admin',
      permissions: ['users.read'],
      allow_account_states: ['active', 'locked'],
      allow_pending_legal: true,
      step_up: true,
    });
  });

  it.each([
    [{ path: 'api/v1/ping' }, 'Path must be'],
    [{ path: '/api/v1/:ID' }, 'Path must be'],
    [{ path: '/healthz' }, 'reserved'],
    [{ operation_id: 'Ping' }, 'camelCase'],
    [{ summary: '' }, 'summary is required'],
    [{ module: 'billing' }, 'Unknown module'],
    [{ rate_limit: 'Global Policy' }, 'rate_limit'],
    [{ path: '/api/v1/users/:id' }, 'exactly the path parameters (id)'],
    [{ request: { params: z.object({ id: z.string() }) } }, 'exactly the path parameters (none)'],
    [{ request: { body: z.object({}) } }, "GET routes can't have a body"],
    [{ permissions: ['users.write'] }, 'Permission users.write is not declared'],
    [{ auth: 'none', permissions: ['users.read'] }, 'auth: none cannot'],
    [{ scopes: ['profile'] }, 'Scopes need auth'],
    [{ auth: 'oauth', scopes: ['bad scope'] }, 'Invalid scope'],
    [{ auth: 'oauth', step_up: true }, 'step_up needs auth: session'],
    [{ auth: 'oauth', allow_aal0: true }, 'allow_aal0 needs auth: session'],
    [{ allow_account_states: [] }, 'must not be empty'],
    [{ allow_account_states: ['sleeping'] }, 'Unknown account state'],
    [{ responses: {} }, 'At least one response'],
    [{ responses: { 404: { description: 'Missing' } } }, 'must be 2xx or 3xx'],
    [{ errors: ['NOPE'] }, 'Error code NOPE is not registered'],
  ])('rejects %o', (overrides, message) => {
    expect(() => {
      define(router(), overrides);
    }).toThrow(message);
  });

  it('rejects duplicate routes and operation IDs', () => {
    const r = router();
    define(r);
    expect(() => {
      define(r, { operation_id: 'pingAgain' });
    }).toThrow('defined more than once');
    expect(() => {
      define(r, { method: 'POST' });
    }).toThrow('operation_id ping is used more than once');
  });

  it('rejects unknown router modules', () => {
    expect(() =>
      createRouter({ service: 'identity', version: '1', module: 'billing' as 'core' }),
    ).toThrow('Unknown module');
  });
});

describe('impliedErrors', () => {
  it('follows the route policy and request', () => {
    const r = router();
    define(r, {
      method: 'POST',
      auth: 'oauth',
      scopes: ['profile'],
      permissions: ['users.read'],
      request: { body: z.object({}) },
    });
    const [route] = r.routes;
    expect(route && impliedErrors(route)).toEqual([
      'IDENTITY_TOKEN_INVALID',
      'INTERNAL_ERROR',
      'SERVICE_UNAVAILABLE',
      'AUTH_MODE_NOT_ALLOWED',
      'ACCOUNT_STATE_NOT_ALLOWED',
      'PERMISSION_DENIED',
      'INSUFFICIENT_SCOPE',
      'VALIDATION_FAILED',
      'INVALID_JSON',
      'UNSUPPORTED_MEDIA_TYPE',
    ]);
  });
});
