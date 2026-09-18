import { sections } from '@qtiauth/config';
import { createMetrics } from '@qtiauth/observability';
import { createLogger } from '@qtiauth/observability';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod';

import { createHttpApp } from './http.ts';
import { IDENTITY_HEADER, IdentityTokenError } from './identity.ts';
import { definePermissions } from './permissions.ts';
import { defineErrors, ProblemError } from './problems.ts';
import { createRouter } from './routes.ts';
import { generateIdentityKey, identityHeaders } from './testing.ts';

interface Context {
  greeting: string;
}

const key = generateIdentityKey();
const observability = sections.observability.parse({
  logs: { user_id_hash_key: 'test-key' },
  metrics: { process_metrics: false },
});

function setup(options: { keys?: typeof key.keys } = {}) {
  const logs = captureLogs();
  const log = createLogger({
    service: 'identity',
    config: observability.logs,
    destination: logs.destination,
  });
  const metrics = createMetrics(observability.metrics, 'identity');
  const router = createRouter<Context>({
    service: 'identity',
    version: '1.0.0',
    module: 'core',
    permissions: definePermissions({
      'users.read': { description: 'Read users' },
      'safety.csea.access': { description: 'CSEA', wildcard: false },
    }),
    errors: defineErrors({ USER_NOT_FOUND: { status: 404, title: 'User not found' } }),
  });

  router.route({
    method: 'GET',
    path: '/api/v1/users/:user_id',
    operation_id: 'getUser',
    summary: 'Get a user',
    auth: 'session',
    permissions: ['users.read'],
    rate_limit: 'global',
    request: {
      params: z.object({ user_id: z.uuid() }),
      query: z.object({
        expand: z.array(z.string()).optional(),
        verbose: z.coerce.boolean().optional(),
      }),
    },
    responses: {
      200: { description: 'The user', schema: z.object({ id: z.string(), greeting: z.string() }) },
    },
    errors: ['USER_NOT_FOUND'],
    handler: ({ ctx, params, query, identity }) => {
      if (params.user_id === '00000000-0000-4000-8000-000000000000') {
        return Promise.reject(new ProblemError('USER_NOT_FOUND', { detail: 'Gone' }));
      }
      return Promise.resolve({
        status: 200 as const,
        body: {
          id: params.user_id,
          greeting: `${ctx.greeting} ${identity.sub ?? ''} ${String(query.expand?.length ?? 0)}`,
        },
      });
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/passwords',
    operation_id: 'setPassword',
    summary: 'Set a password',
    auth: 'session',
    allow_account_states: ['active', 'locked'],
    allow_pending_parental_consent: true,
    rate_limit: 'auth_password',
    request: { body: z.object({ password: z.string().min(8) }) },
    responses: { 204: { description: 'Set' } },
    handler: ({ log, body }) => {
      log.info('password set', { password: body.password });
      return Promise.resolve({ status: 204 as const, headers: { 'x-extra': 'yes' } });
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/csea',
    operation_id: 'cseaCases',
    summary: 'CSEA cases',
    auth: 'session',
    permissions: ['safety.csea.access'],
    rate_limit: 'global',
    responses: { 200: { description: 'OK' } },
    handler: () => Promise.resolve(new Response('ok')),
  });

  router.route({
    method: 'GET',
    path: '/api/v1/games/scores',
    operation_id: 'scores',
    summary: 'Scores',
    auth: 'oauth',
    scopes: ['games.read'],
    rate_limit: 'global',
    responses: { 200: { description: 'OK' } },
    handler: () => Promise.reject(new ProblemError('USER_NOT_FOUND')),
  });

  router.route({
    method: 'GET',
    path: '/api/v1/public/broken',
    operation_id: 'broken',
    summary: 'Broken',
    auth: 'none',
    rate_limit: 'global',
    responses: { 200: { description: 'OK' } },
    handler: () => Promise.reject(new Error('connection string postgres://secret@db')),
  });

  const app = createHttpApp({
    router,
    context: { greeting: 'hello' },
    log,
    metrics,
    identityKeys: options.keys ?? key.keys,
    clockTolerance: 5_000,
    readiness: () => Promise.resolve({ status: 'ok', service: 'identity', checks: {} }),
    openapi: () => ({ openapi: '3.1.1' }),
  });
  const request = (path: string, init: RequestInit = {}) => app.request(path, init);
  return { app, logs, metrics, request };
}

const userId = '0192f4c6-1c5e-7d5c-9b1a-3f2e4d5c6b7a';
let env: ReturnType<typeof setup>;

beforeEach(() => {
  env = setup();
});

async function problem(response: Response) {
  expect(response.headers.get('content-type')).toBe('application/problem+json');
  return (await response.json()) as Record<string, unknown>;
}

describe('internal endpoints', () => {
  it('serves health, metrics and OpenAPI without an identity token', async () => {
    expect((await env.request('/healthz')).status).toBe(200);
    expect(await (await env.request('/readyz')).json()).toMatchObject({ status: 'ok' });
    expect(await (await env.request('/openapi.json')).json()).toEqual({ openapi: '3.1.1' });

    await env.request(`/api/v1/users/${userId}`, {
      headers: identityHeaders(key, 'identity', { permissions: ['users.read'] }),
    });
    const metrics = await (await env.request('/metrics')).text();
    expect(metrics).toContain(
      'qtiauth_http_requests_total{method="GET",route="/api/v1/users/:user_id",status="200",service="identity"} 1',
    );
  });

  it('answers unknown routes with NOT_FOUND', async () => {
    const response = await env.request('/api/v1/nope');
    expect(response.status).toBe(404);
    expect(await problem(response)).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('identity tokens', () => {
  it('rejects requests without a valid token, even on auth: none routes', async () => {
    for (const headers of [{}, { [IDENTITY_HEADER]: 'nope' }, identityHeaders(key, 'games')]) {
      const response = await env.request('/api/v1/public/broken', { headers });
      expect(response.status).toBe(401);
      expect(await problem(response)).toMatchObject({ code: 'IDENTITY_TOKEN_INVALID' });
    }
    expect(await env.metrics.render()).toContain(
      'qtiauth_http_identity_rejections_total{reason="wrong_audience",service="identity"} 1',
    );
  });

  it('answers 503 when the gateway keys are unavailable', async () => {
    const { request } = setup({
      keys: { get: () => Promise.reject(new IdentityTokenError('keys_unavailable', 'down')) },
    });
    const response = await request('/api/v1/public/broken', {
      headers: identityHeaders(key, 'identity', { auth: 'none' }),
    });
    expect(response.status).toBe(503);
    expect(await problem(response)).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('passes the identity, request ID and context to the handler', async () => {
    const response = await env.request(`/api/v1/users/${userId}?expand=a&expand=b`, {
      headers: identityHeaders(key, 'identity', {
        sub: 'user-1',
        request_id: 'req-123',
        permissions: ['users.*'],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req-123');
    expect(await response.json()).toEqual({ id: userId, greeting: 'hello user-1 2' });
  });
});

describe('route policy', () => {
  it('checks the auth mode', async () => {
    const response = await env.request(`/api/v1/users/${userId}`, {
      headers: identityHeaders(key, 'identity', { auth: 'oauth', permissions: ['users.read'] }),
    });
    expect(await problem(response)).toMatchObject({ status: 401, code: 'AUTH_MODE_NOT_ALLOWED' });
  });

  it('checks permissions, never matching wildcards against no-wildcard permissions', async () => {
    const denied = await env.request(`/api/v1/users/${userId}`, {
      headers: identityHeaders(key, 'identity', { permissions: ['sessions.read'] }),
    });
    expect(await problem(denied)).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });

    const wildcard = await env.request('/api/v1/csea', {
      headers: identityHeaders(key, 'identity', { permissions: ['*'] }),
    });
    expect(wildcard.status).toBe(403);

    const explicit = await env.request('/api/v1/csea', {
      headers: identityHeaders(key, 'identity', { permissions: ['safety.csea.access'] }),
    });
    expect(explicit.status).toBe(200);
  });

  it('checks scopes', async () => {
    const response = await env.request('/api/v1/games/scores', {
      headers: identityHeaders(key, 'identity', { auth: 'oauth', scopes: ['profile'] }),
    });
    expect(await problem(response)).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      missing_scopes: ['games.read'],
    });
  });

  it('checks the account state', async () => {
    const headers = (state: 'banned' | 'locked' | 'pending_parental_consent') => ({
      ...identityHeaders(key, 'identity', { account_state: state }),
      'content-type': 'application/json',
    });
    const body = JSON.stringify({ password: 'long enough' });

    const banned = await env.request('/api/v1/passwords', {
      method: 'POST',
      headers: headers('banned'),
      body,
    });
    expect(await problem(banned)).toMatchObject({ status: 403, code: 'ACCOUNT_STATE_NOT_ALLOWED' });

    for (const state of ['locked', 'pending_parental_consent'] as const) {
      const allowed = await env.request('/api/v1/passwords', {
        method: 'POST',
        headers: headers(state),
        body,
      });
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get('x-extra')).toBe('yes');
    }
  });
});

describe('request validation', () => {
  const headers = identityHeaders(key, 'identity', { permissions: ['users.read'] });

  it('reports every invalid field', async () => {
    const response = await env.request('/api/v1/users/not-a-uuid?verbose=1&expand=x', { headers });
    expect(response.status).toBe(400);
    expect(await problem(response)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [
        { location: 'params', path: 'user_id', code: 'invalid_format' },
        { location: 'query', path: 'expand', code: 'invalid_type' },
      ],
    });
  });

  it('needs a JSON body', async () => {
    const post = (init: RequestInit) =>
      env.request('/api/v1/passwords', { method: 'POST', ...init });
    const auth = identityHeaders(key, 'identity');

    const text = await post({ headers: { ...auth, 'content-type': 'text/plain' }, body: 'hi' });
    expect(await problem(text)).toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });

    const broken = await post({
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{',
    });
    expect(await problem(broken)).toMatchObject({ status: 400, code: 'INVALID_JSON' });

    const short = await post({
      headers: { ...auth, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ password: 'short' }),
    });
    expect(await problem(short)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ location: 'body', path: 'password', code: 'too_small' }],
    });
  });
});

describe('errors', () => {
  it('turns ProblemError into Problem Details with the request ID', async () => {
    const response = await env.request('/api/v1/users/00000000-0000-4000-8000-000000000000', {
      headers: identityHeaders(key, 'identity', { permissions: ['users.read'], request_id: 'r-9' }),
    });
    expect(response.status).toBe(404);
    expect(await problem(response)).toEqual({
      type: 'urn:qtiauth:problem:USER_NOT_FOUND',
      title: 'User not found',
      status: 404,
      code: 'USER_NOT_FOUND',
      detail: 'Gone',
      request_id: 'r-9',
    });
  });

  it('warns when a route returns a code it does not declare', async () => {
    await env.request('/api/v1/games/scores', {
      headers: identityHeaders(key, 'identity', { auth: 'oauth', scopes: ['games.read'] }),
    });
    expect(env.logs.records()).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'route returned an error code it does not declare',
        code: 'USER_NOT_FOUND',
      }),
    );
  });

  it('hides unexpected errors from the caller but logs them', async () => {
    const response = await env.request('/api/v1/public/broken', {
      headers: identityHeaders(key, 'identity', { auth: 'none' }),
    });
    expect(response.status).toBe(500);
    const body = await problem(response);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(env.logs.records()).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'request failed' }),
    );
  });
});

describe('logs', () => {
  it('never contain identity tokens, passwords or raw user IDs', async () => {
    const auth = identityHeaders(key, 'identity', { sub: userId, account_state: 'active' });
    const token = auth[IDENTITY_HEADER] ?? '';
    const password = 'correct horse battery staple';

    await env.request('/api/v1/passwords', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    await env.request('/api/v1/public/broken', {
      headers: { ...identityHeaders(key, 'games'), 'x-request-id': 'r' },
    });

    expect(env.logs.records()).toContainEqual(
      expect.objectContaining({ message: 'password set', password: '[REDACTED]' }),
    );
    assertLogsScrubbed(env.logs.lines, [token, password, userId]);
  });
});
