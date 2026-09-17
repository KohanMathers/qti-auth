import { createLogger, createMetrics } from '@qtiauth/observability';
import { captureLogs } from '@qtiauth/observability/testing';
import { createHttpApp, openApiDocument, serviceSchema } from '@qtiauth/service-kit';
import { generateIdentityKey, identityHeaders } from '@qtiauth/service-kit/testing';
import { describe, expect, it } from 'vitest';

import { type Context, definition, router } from './service.ts';

const key = generateIdentityKey();

function app(overrides: Record<string, unknown> = {}) {
  const config = serviceSchema(definition).parse({
    observability: { logs: { user_id_hash_key: 'test' }, metrics: { process_metrics: false } },
    ...overrides,
  });
  const logs = captureLogs();
  const log = createLogger({
    service: 'identity',
    config: config.observability.logs,
    destination: logs.destination,
  });
  const metrics = createMetrics(config.observability.metrics, 'identity');
  const context = { service: 'identity', config, log, metrics } as unknown as Context;
  return createHttpApp({
    router,
    context,
    log,
    metrics,
    identityKeys: key.keys,
    clockTolerance: 5_000,
    readiness: () => Promise.resolve({ status: 'ok', service: 'identity', checks: {} }),
    openapi: () => openApiDocument(router),
  });
}

const anonymous = identityHeaders(key, 'identity', {
  auth: 'none',
  sub: null,
  sid: null,
  account_state: null,
  age_band: null,
  amr: [],
  acr: null,
});

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { ...anonymous, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('magic link confirmation page', () => {
  it('asks for a click instead of using the link, escaping what it echoes', async () => {
    const response = await app().request(
      `/auth/magic-link?token=${encodeURIComponent('"><script>x</script>')}`,
      { headers: anonymous },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('<form method="post" action="magic-link">');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
    expect(html).not.toContain('<script>');
  });

  it('explains a missing link', async () => {
    const response = await app().request('/auth/magic-link', { headers: anonymous });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('This link can’t be used');
  });

  it('asks again for a date of birth that is not real, keeping the signup token', async () => {
    const response = await app().request('/auth/signup', {
      method: 'POST',
      headers: { ...anonymous, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ signup_token: 'tok<en>', date_of_birth: '2999-01-01' }),
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('name="signup_token" value="tok&lt;en&gt;"');
  });

  it('offers password and magic-link signup', async () => {
    const response = await app().request('/auth/signup', { headers: anonymous });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="register"');
    expect(html).toContain('href="magic-link/start"');
  });
});

describe('when magic links are turned off', () => {
  const disabled = () => app({ features: { auth: { magic_link: { enabled: false } } } });

  it('refuses to send or use them', async () => {
    const start = await disabled().request(
      '/api/v1/auth/magic-link/start',
      json({ email: 'sam@example.com' }),
    );
    expect(start.status).toBe(403);
    expect(await start.json()).toMatchObject({ code: 'AUTH_METHOD_DISABLED' });

    const verify = await disabled().request(
      '/api/v1/auth/magic-link/verify',
      json({ token: 'x'.repeat(43) }),
    );
    expect(await verify.json()).toMatchObject({ code: 'AUTH_METHOD_DISABLED' });

    const page = await disabled().request('/auth/magic-link?token=abc', { headers: anonymous });
    expect(page.status).toBe(403);
  });
});

describe('when passwords are turned off', () => {
  const disabled = () => app({ features: { auth: { password: { enabled: false } } } });

  it('refuses password routes', async () => {
    const login = await disabled().request(
      '/api/v1/auth/password/login',
      json({ email: 'sam@example.com', password: 'long-enough-secret' }),
    );
    expect(await login.json()).toMatchObject({ code: 'AUTH_METHOD_DISABLED' });
    const page = await disabled().request('/auth/login', { headers: anonymous });
    expect(page.status).toBe(403);
  });
});

describe('password pages', () => {
  it('asks for a click on a reset link, escaping what it echoes', async () => {
    const response = await app().request(
      `/auth/reset-password?token=${encodeURIComponent('"><script>x</script>')}`,
      { headers: anonymous },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<form method="post" action="reset-password">');
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
    expect(html).not.toContain('<script>');
  });

  it('links to forgot-password from the login page', async () => {
    const response = await app().request('/auth/login', { headers: anonymous });
    expect(await response.text()).toContain('href="forgot-password"');
  });

  it('asks for a click on a verification link', async () => {
    const response = await app().request('/auth/verify-email?token=abc', { headers: anonymous });
    expect(await response.text()).toContain('action="verify-email"');
  });
});

describe('request validation', () => {
  it('checks addresses, locales and return paths before doing anything', async () => {
    const response = await app().request(
      '/api/v1/auth/magic-link/start',
      json({ email: 'not-an-email', locale: 'en_gb', return_to: '//evil.example.net' }),
    );
    expect(response.status).toBe(400);
    const problem = (await response.json()) as { errors: { path: string }[] };
    expect(problem.errors.map((error) => error.path)).toEqual(['email', 'locale', 'return_to']);
  });

  it('refuses dates of birth in the future', async () => {
    const response = await app().request(
      '/api/v1/auth/magic-link/signup',
      json({ signup_token: 'x'.repeat(43), date_of_birth: '2999-01-01' }),
    );
    expect(await response.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'date_of_birth' }],
    });
  });

  it('only lets signed-in callers list sessions', async () => {
    const response = await app().request('/api/v1/sessions', { headers: anonymous });
    expect(await response.json()).toMatchObject({ code: 'AUTH_MODE_NOT_ALLOWED' });
  });
});
