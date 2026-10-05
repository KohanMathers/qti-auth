import { randomBytes } from 'node:crypto';

import { sections } from '@qtiauth/config';
import { createLogger } from '@qtiauth/observability';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import {
  AUTH_MODES,
  createServiceRouter,
  FAMILY_CLEAR_HEADER,
  FAMILY_EXPIRES_HEADER,
  FAMILY_TOKEN_HEADER,
  FLOW_BINDING_HEADER,
  hashSessionToken,
  IDENTITY_HEADER,
  type ManifestRoute,
  openApiDocument,
  type ResolvedAccessToken,
  type ResolvedSession,
  REVOKED_SESSIONS_HEADER,
  type RouteManifest,
  SESSION_CLEAR_HEADER,
  SESSION_EXPIRES_HEADER,
  SESSION_TOKEN_HEADER,
  staticIdentityKeys,
  verifyIdentityToken,
} from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { trustedProxies } from './client-ip.ts';
import { allowedOrigins } from './cors.ts';
import { createGatewayHandler } from './gateway.ts';
import { hstsValue } from './headers.ts';
import { memoryKeySetStore, openKeyring } from './identity-keys.ts';
import { featuresReport, healthReport } from './meta.ts';
import type { GatewayMetrics } from './metrics.ts';
import { mergeOpenApi } from './openapi.ts';
import type { ForwardRequest, ForwardResult } from './proxy.ts';
import { createRateLimiter, memoryRateLimitStore } from './rate-limit.ts';
import { buildRouteTable } from './routes.ts';
import { definition, type LocalContext, router } from './service.ts';
import { createSessionResolver, memorySessionCache } from './sessions.ts';
import { resolveSurfaces } from './surfaces.ts';

const HOST = 'me.example.com';
const ORIGIN = `https://${HOST}`;
const TOKEN = randomBytes(32).toString('base64url');

function route(overrides: Partial<ManifestRoute>): ManifestRoute {
  return {
    method: 'GET',
    path: '/api/v1/me',
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
    ...overrides,
  };
}

const identityManifest: RouteManifest = {
  service: 'identity',
  version: '1.0.0',
  permissions: [],
  notifications: [],
  routes: [
    route({}),
    route({
      method: 'POST',
      path: '/api/v1/auth/magic-link',
      auth: 'none',
      rate_limit: 'magic_link',
    }),
    route({ method: 'DELETE', path: '/api/v1/sessions/:session_id' }),
    route({ path: '/api/v1/legal', allow_pending_legal: true }),
    route({ path: '/api/v1/slow', auth: 'none' }),
    route({ path: '/api/v1/userinfo', auth: 'oauth', scopes: ['openid'] }),
    route({ path: '/api/v1/games/intake', auth: 'service', scopes: ['games'] }),
    route({ path: '/auth/bind', auth: 'session', allow_account_states: ['active'] }),
    route({ path: '/auth/login', auth: 'none' }),
  ],
};

function session(overrides: Partial<ResolvedSession> = {}): ResolvedSession {
  return {
    session_id: 's1',
    user_id: '0199a0e0-0000-7000-8000-000000000001',
    account_state: 'active',
    permissions: [],
    restrictions: [],
    age_band: 'adult',
    parental_controls: null,
    amr: ['email'],
    acr: 'aal1',
    step_up_at: null,
    legal_acceptance_required: false,
    two_factor_enrolment_required: false,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

interface SetupOptions {
  session?: ResolvedSession | null;
  oauth?: ResolvedAccessToken | null;
  rateLimits?: unknown;
  manifests?: RouteManifest[];
  local?: typeof router;
  upstream?: (request: ForwardRequest) => ForwardResult;
  surfaces?: ReturnType<typeof resolveSurfaces>;
}

async function setup(options: SetupOptions = {}) {
  const oauthToken = options.oauth;
  const config = {
    cookies: sections.cookies.parse({}),
    gateway: sections.gateway.parse({ http: { max_body_size: 1024 } }),
    security: sections.security.parse({}),
    geoip: sections.geoip.parse({}),
    session_security: sections.session_security.parse({}),
    features: sections.features.parse({}),
  };
  const surfaces =
    options.surfaces ??
    resolveSurfaces({
      surfaces: sections.surfaces.parse({
        account: { hosts: [HOST], base_path: '/' },
        support: { hosts: [HOST], base_path: '/support' },
        api: { hosts: [HOST], base_path: '/api' },
      }),
    });
  const logs = captureLogs();
  const log = createLogger({
    service: 'gateway',
    config: sections.observability.parse({ logs: { user_id_hash_key: 'test' } }).logs,
    destination: logs.destination,
  });
  const keyring = await openKeyring({
    store: memoryKeySetStore(),
    encryptionKey: randomBytes(32),
    rotateAfter: 86_400_000,
    retainAfterRotation: 3_600_000,
  });
  const rateLimiter = createRateLimiter({
    policies: sections.rate_limits.parse(options.rateLimits ?? {}),
    store: memoryRateLimitStore(),
    metrics: { checked: () => undefined },
    onStoreError: () => undefined,
  });
  const local = options.local ?? router;
  const table = buildRouteTable({
    surfaces,
    rateLimits: rateLimiter.policies,
    manifests: [local.manifest(), ...(options.manifests ?? [identityManifest])],
  });
  const forwarded: ForwardRequest[] = [];
  const recorded: { route: string; status: number }[] = [];
  const metrics: GatewayMetrics = {
    request: (labels) => recorded.push({ route: labels.route, status: labels.status }),
    upstreamError: () => undefined,
    keyRotated: () => undefined,
    keyLoaded: () => undefined,
  };
  const resolved = options.session === undefined ? session() : options.session;
  const resolves: string[] = [];
  const handler = createGatewayHandler({
    config,
    log,
    metrics,
    surfaces,
    allowedOrigins: allowedOrigins({ cors: sections.cors.parse({}) }, surfaces),
    proxies: trustedProxies(['10.0.0.0/8']),
    hsts: hstsValue(config.gateway.hsts),
    routes: () => table,
    rateLimiter,
    sessions: createSessionResolver({
      cache: memorySessionCache(),
      cacheTtl: 60_000,
      metrics: { lookup: () => undefined },
      onError: () => undefined,
      resolve: (request) => {
        resolves.push(request.binding_token_hash);
        return Promise.resolve({
          status: 'ok',
          data: {
            session: request.binding_token_hash === hashSessionToken(TOKEN) ? resolved : null,
          },
        });
      },
    }),
    signingKey: () => keyring.signingKey(),
    local,
    ...(oauthToken === undefined
      ? {}
      : {
          accessTokens: {
            resolve: () =>
              Promise.resolve(
                oauthToken === null
                  ? { status: 'none' as const }
                  : { status: 'ok' as const, token: oauthToken },
              ),
          },
        }),
    localContext: (surface) => ({
      surface,
      health: () =>
        healthReport({
          config: {
            branding: sections.branding.parse({}),
            features: sections.features.parse({}),
            parental: sections.parental.parse({}),
            password: sections.password.parse({}),
            geoip: sections.geoip.parse({}),
            storage: sections.storage.parse({
              enabled: true,
              endpoint: 'http://minio:9000',
              access_key: 'k',
              secret_key: 's',
            }),
          },
          services: [],
          routeProblems: table.problems,
          starting: false,
        }),
      features: () =>
        featuresReport({
          config: {
            branding: sections.branding.parse({}),
            features: sections.features.parse({}),
            parental: sections.parental.parse({}),
            password: sections.password.parse({}),
            geoip: sections.geoip.parse({}),
            storage: sections.storage.parse({
              enabled: true,
              endpoint: 'http://minio:9000',
              access_key: 'k',
              secret_key: 's',
            }),
          },
          surfaces,
          isRunning: () => false,
        }),
      about: () => ({
        product_name: 'Example Account',
        geoip: { source: 'dbip_lite', available: false, attribution: null },
      }),
      openapi: (target) =>
        Promise.resolve(
          mergeOpenApi({
            surface: target,
            table,
            documents: new Map([['gateway', openApiDocument(router)]]),
            title: 'Example API',
            version: '0.0.0',
          }),
        ),
    }),
    upstreamUrl: (service) => `http://${service}:8080`,
    forward: (request) => {
      forwarded.push(request);
      return Promise.resolve(
        options.upstream?.(request) ?? {
          status: 'ok',
          response: Response.json({ ok: true }, { headers: { server: 'hono' } }),
        },
      );
    },
  });

  const request = (path: string, init: RequestInit & { peer?: string; host?: string } = {}) => {
    const headers = new Headers(init.headers);
    const host = init.host ?? HOST;
    if (!headers.has('host')) headers.set('host', host);
    return handler(new Request(`http://${host}${path}`, { ...init, headers }), {
      peer: init.peer ?? '203.0.113.9',
      localPort: 8000,
    });
  };
  const verify = (forward: ForwardRequest | undefined, audience = 'identity') =>
    verifyIdentityToken(forward?.headers.get(IDENTITY_HEADER) ?? undefined, {
      audience,
      keys: staticIdentityKeys({ keys: [] }),
      clockTolerance: 5_000,
    }).catch(async () =>
      verifyIdentityToken(forward?.headers.get(IDENTITY_HEADER) ?? undefined, {
        audience,
        keys: staticIdentityKeys(await keyring.jwks()),
        clockTolerance: 5_000,
      }),
    );
  return { request, forwarded, verify, logs, table, recorded, resolves };
}

const signedIn = { cookie: `__Host-qtiauth_session=${TOKEN}` };

describe('gateway handler', () => {
  it('proxies to the owning service with a fresh identity token and nothing else', async () => {
    const { request, forwarded, verify } = await setup();
    const response = await request('/api/v1/me?expand=1', {
      headers: {
        ...signedIn,
        authorization: 'Bearer abc',
        [IDENTITY_HEADER]: 'forged',
        'x-forwarded-for': '6.6.6.6',
        'accept-language': 'en-GB',
        'x-request-id': 'req-123',
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const [sent] = forwarded;
    expect(sent?.url).toBe('http://identity:8080/api/v1/me?expand=1');
    expect(Object.fromEntries(sent?.headers ?? [])).toEqual({
      'accept-encoding': 'identity',
      'accept-language': 'en-GB',
      [IDENTITY_HEADER.toLowerCase()]: expect.any(String) as unknown,
      'x-request-id': 'req-123',
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-host': HOST,
      'x-forwarded-proto': 'https',
    });
    expect(await verify(sent)).toMatchObject({
      aud: 'identity',
      auth: 'session',
      sub: session().user_id,
      sid: 's1',
      request_id: 'req-123',
      account_state: 'active',
    });
  });

  it('strips the /api prefix of the api surface and keeps it for services', async () => {
    const { request, forwarded } = await setup();
    expect((await request('/support/api/v1/me', { headers: signedIn })).status).toBe(200);
    expect(forwarded[0]?.url).toBe('http://identity:8080/api/v1/me');
    expect(
      (
        await request('/api/v1/sessions/s9', {
          method: 'DELETE',
          headers: { ...signedIn, origin: ORIGIN },
        })
      ).status,
    ).toBe(200);
    expect(forwarded[1]?.url).toBe('http://identity:8080/api/v1/sessions/s9');
  });

  it('trusts X-Forwarded-For only from trusted proxies', async () => {
    const { request, forwarded } = await setup();
    await request('/api/v1/slow', {
      peer: '10.1.1.1',
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    expect(forwarded[0]?.headers.get('x-forwarded-for')).toBe('198.51.100.7');
  });

  it('adds security headers to every response and drops server banners', async () => {
    const { request } = await setup();
    for (const response of [
      await request('/api/v1/me', { headers: signedIn }),
      await request('/nowhere'),
      await request('/', { headers: { host: 'unknown.example.net' } }),
    ]) {
      expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.has('server')).toBe(false);
      expect(response.headers.get('x-request-id')).toBeTruthy();
    }
  });

  it('needs a session, and clears a cookie that no longer resolves', async () => {
    const { request, forwarded } = await setup();
    const anonymous = await request('/api/v1/me');
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });

    const stale = await request('/api/v1/me', {
      headers: { cookie: `__Host-qtiauth_session=${randomBytes(32).toString('base64url')}` },
    });
    expect(stale.status).toBe(401);
    expect(stale.headers.get('set-cookie')).toContain('__Host-qtiauth_session=; Path=/; Max-Age=0');
    expect(forwarded).toHaveLength(0);
  });

  it('sends a browser navigation that needs a session to login', async () => {
    const { request, forwarded } = await setup({ session: null });
    const browse = await request('/api/v1/me', { headers: { accept: 'text/html' } });
    expect(browse.status).toBe(302);
    expect(browse.headers.get('location')).toBe(
      `https://${HOST}/sign-in?return_to=%2Fapi%2Fv1%2Fme`,
    );
    expect(forwarded).toHaveLength(0);
  });

  it('accepts a bearer access token on oauth routes and rejects it on session routes', async () => {
    const oauth: ResolvedAccessToken = {
      jti: 't1',
      auth: 'oauth',
      sub: 'u1',
      client_id: 'game',
      game_id: null,
      scopes: ['openid', 'profile'],
      sid: 's1',
      account_state: 'active',
      restrictions: [],
      age_band: 'adult',
      parental_controls: null,
      amr: ['email'],
      acr: 'aal1',
    };
    const { request, forwarded, verify } = await setup({ session: null, oauth });
    const allowed = await request('/api/v1/userinfo', {
      headers: { authorization: 'Bearer oauth-access-token' },
    });
    expect(allowed.status).toBe(200);
    expect(await verify(forwarded[0])).toMatchObject({
      auth: 'oauth',
      sub: 'u1',
      client_id: 'game',
      scopes: ['openid', 'profile'],
    });

    const sessionRoute = await request('/api/v1/me', {
      headers: { authorization: 'Bearer oauth-access-token' },
    });
    expect(sessionRoute.status).toBe(401);
    expect(await sessionRoute.json()).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(forwarded).toHaveLength(1);
  });

  it('needs the route’s scopes on the access token', async () => {
    const { request } = await setup({
      session: null,
      oauth: {
        jti: 't1',
        auth: 'oauth',
        sub: 'u1',
        client_id: 'game',
        game_id: null,
        scopes: ['profile'],
        sid: null,
        account_state: 'active',
        restrictions: [],
        age_band: 'adult',
        parental_controls: null,
        amr: [],
        acr: 'aal1',
      },
    });
    const response = await request('/api/v1/userinfo', {
      headers: { authorization: 'Bearer oauth-access-token' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      missing_scopes: ['openid'],
    });
  });

  it('accepts a client-credentials token only on service routes', async () => {
    const service: ResolvedAccessToken = {
      jti: 't1',
      auth: 'service',
      sub: 'studio',
      client_id: 'studio',
      game_id: null,
      scopes: ['games'],
      sid: null,
      account_state: 'active',
      restrictions: [],
      age_band: null,
      parental_controls: null,
      amr: [],
      acr: 'aal1',
    };
    const { request, forwarded, verify } = await setup({ session: null, oauth: service });
    const allowed = await request('/api/v1/games/intake', {
      headers: { authorization: 'Bearer oauth-access-token' },
    });
    expect(allowed.status).toBe(200);
    expect(await verify(forwarded[0])).toMatchObject({
      auth: 'service',
      sub: null,
      client_id: 'studio',
      scopes: ['games'],
    });

    const sessionRoute = await request('/api/v1/me', {
      headers: { authorization: 'Bearer oauth-access-token' },
    });
    expect(sessionRoute.status).toBe(401);
    const userinfo = await request('/api/v1/userinfo', {
      headers: { authorization: 'Bearer oauth-access-token' },
    });
    expect(userinfo.status).toBe(401);
    expect(forwarded).toHaveLength(1);
  });

  it('silently binds a browser navigation on another host to the account session', async () => {
    const split = resolveSurfaces({
      surfaces: sections.surfaces.parse({
        account: { hosts: ['account.example.co.uk'] },
        support: { hosts: ['support.example.com'] },
        api: { hosts: ['auth.example.co.uk'] },
      }),
    });
    const { request, forwarded } = await setup({ session: null, surfaces: split });
    const api = await request('/api/v1/me', { host: 'support.example.com' });
    expect(api.status).toBe(401);
    expect(forwarded).toHaveLength(0);

    const browse = await request('/api/v1/me', {
      host: 'support.example.com',
      headers: { accept: 'text/html' },
    });
    expect(browse.status).toBe(302);
    expect(browse.headers.get('location')).toBe(
      'https://account.example.co.uk/auth/bind?target=support&return=%2Fapi%2Fv1%2Fme',
    );
    expect(browse.headers.get('set-cookie')).toContain('__Host-qtiauth_session_bound=1');

    const loop = await request('/api/v1/me', {
      host: 'support.example.com',
      headers: { accept: 'text/html', cookie: '__Host-qtiauth_session_bound=1' },
    });
    expect(loop.status).toBe(401);

    const login = await request('/auth/bind?target=support&return=%2F', {
      host: 'account.example.co.uk',
      headers: { accept: 'text/html' },
    });
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe(
      'https://account.example.co.uk/sign-in?return_to=%2Fauth%2Fbind%3Ftarget%3Dsupport%26return%3D%252F',
    );
  });

  it('returns the gate codes for banned, legal and parental states', async () => {
    const cases: [Partial<ResolvedSession>, string, string][] = [
      [{ account_state: 'banned' }, '/api/v1/me', 'ACCOUNT_BANNED'],
      [{ account_state: 'pending_parental_consent' }, '/api/v1/me', 'PARENTAL_CONSENT_PENDING'],
      [{ legal_acceptance_required: true }, '/api/v1/me', 'LEGAL_ACCEPTANCE_REQUIRED'],
      [{ two_factor_enrolment_required: true }, '/api/v1/me', 'TWO_FACTOR_ENROLMENT_REQUIRED'],
    ];
    for (const [overrides, path, code] of cases) {
      const { request } = await setup({ session: session(overrides) });
      const response = await request(path, { headers: signedIn });
      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(await response.json()).toMatchObject({ code, type: `urn:qtiauth:problem:${code}` });
    }
    const { request } = await setup({ session: session({ legal_acceptance_required: true }) });
    expect((await request('/api/v1/legal', { headers: signedIn })).status).toBe(200);
  });

  it('refuses state-changing requests from other origins', async () => {
    const { request, forwarded } = await setup();
    const evil = await request('/api/v1/sessions/s1', {
      method: 'DELETE',
      headers: { ...signedIn, origin: 'https://evil.example.net' },
    });
    expect(await evil.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
    const missing = await request('/api/v1/sessions/s1', { method: 'DELETE', headers: signedIn });
    expect(missing.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it('answers CORS preflights and allows credentials for surface origins', async () => {
    const { request } = await setup();
    const preflight = await request('/api/v1/me', {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const response = await request('/api/v1/me', { headers: { ...signedIn, origin: ORIGIN } });
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('distinguishes unknown routes, wrong methods and oversized bodies', async () => {
    const { request } = await setup();
    const missing = await request('/api/v1/nope');
    expect(missing.status).toBe(404);
    const wrong = await request('/api/v1/me', { method: 'PUT', headers: { origin: ORIGIN } });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
    const large = await request('/api/v1/auth/magic-link', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a'.repeat(2000) }),
    });
    expect(await large.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('maps service failures to 503 and 504', async () => {
    const down = await setup({
      upstream: () => ({ status: 'unreachable', error: new Error('ECONNREFUSED') }),
    });
    expect(await (await down.request('/api/v1/slow')).json()).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    const slow = await setup({ upstream: () => ({ status: 'timeout' }) });
    const response = await slow.request('/api/v1/slow');
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });

  it('rate-limits with the route policy and sends RateLimit headers', async () => {
    const { request } = await setup({
      rateLimits: {
        magic_link_email: { per: 'email', limit: 1, window: '1h' },
      },
    });
    const send = (email: string) =>
      request('/api/v1/auth/magic-link', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    const first = await send('ann@example.com');
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-remaining')).toBe('0');
    const second = await send('ANN@example.com');
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await second.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect((await send('bob@example.com')).status).toBe(200);
  });

  it('rate-limits every route in the table, whatever its auth mode', async () => {
    const routes = AUTH_MODES.flatMap((auth, i) =>
      (['GET', 'POST'] as const).map((method) =>
        route({ method, auth, path: `/api/v1/mode${String(i)}/:thing_id`, rate_limit: 'tight' }),
      ),
    );
    const manifests: RouteManifest[] = [
      { service: 'identity', version: '1.0.0', permissions: [], notifications: [], routes },
    ];
    const { request, table } = await setup({
      manifests,
      rateLimits: {
        tight: { per: 'ip', limit: 1, window: '1h' },
        global: { per: 'ip', limit: 3, window: '1h' },
      },
    });
    const limits: Record<string, number> = { tight: 1, global: 3 };

    expect(table.mounts.length).toBeGreaterThan(routes.length);
    for (const mount of table.mounts) {
      const base = { account: '', support: '/support', api: '/api' }[mount.surface];
      const path = `${base}${mount.path.replace(':thing_id', 'x')}`;
      const init = {
        method: mount.method,
        headers: { ...signedIn, origin: ORIGIN },
        peer: `198.51.100.${String(table.mounts.indexOf(mount))}`,
      };
      for (let i = 0; i < (limits[mount.route.route.rate_limit] ?? 0); i++) {
        expect((await request(path, init)).status, `${mount.method} ${path}`).not.toBe(429);
      }
      const limited = await request(path, init);
      expect(limited.status, `${mount.method} ${path}`).toBe(429);
    }
  });

  it('serves its own meta routes, rate-limited like any other', async () => {
    const { request } = await setup({
      rateLimits: { global: { per: 'ip', limit: 3, window: '1m' } },
    });
    const features = await request('/api/v1/meta/features');
    expect(await features.json()).toMatchObject({ modules: { identity: false } });
    const health = await request('/support/api/v1/meta/health');
    expect(await health.json()).toMatchObject({ status: 'degraded' });
    const openapi = await request('/api/v1/openapi.json');
    expect(await openapi.json()).toMatchObject({
      servers: [{ url: '/api' }],
      paths: { '/v1/meta/health': { get: { operationId: 'getHealth' } } },
    });
    expect((await request('/api/v1/meta/features')).status).toBe(429);
  });

  it('parses params, query and body on local gateway routes', async () => {
    const local = createServiceRouter<LocalContext>(definition);
    local.route({
      method: 'POST',
      path: '/api/v1/echo/:name',
      operation_id: 'echo',
      summary: 'Echo',
      tags: ['meta'],
      auth: 'none',
      rate_limit: 'global',
      request: {
        params: z.object({ name: z.string() }),
        query: z.object({ n: z.coerce.number() }),
        body: z.object({ extra: z.string() }),
      },
      responses: {
        200: {
          description: 'Echo',
          schema: z.object({ name: z.string(), n: z.number(), extra: z.string() }),
        },
      },
      handler: ({ params, query, body }) =>
        Promise.resolve({
          status: 200 as const,
          body: { name: params.name, n: query.n, extra: body.extra },
        }),
    });
    const { request } = await setup({ local, manifests: [] });
    const response = await request('/api/v1/echo/sam?n=3', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ extra: 'x' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'sam', n: 3, extra: 'x' });
  });

  it('sets the session cookie identity asks for and hides the headers it used', async () => {
    const issued = randomBytes(32).toString('base64url');
    const { request } = await setup({
      upstream: () => ({
        status: 'ok',
        response: new Response(null, {
          status: 204,
          headers: {
            [SESSION_TOKEN_HEADER]: issued,
            [SESSION_EXPIRES_HEADER]: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
      }),
    });
    const response = await request('/api/v1/slow');
    expect(response.headers.get('set-cookie')).toMatch(
      new RegExp(
        `^__Host-qtiauth_session=${issued}; Path=/; Max-Age=(?:3599|3600); Secure; HttpOnly; SameSite=Lax$`,
      ),
    );
    expect(response.headers.has(SESSION_TOKEN_HEADER)).toBe(false);
    expect(response.headers.has(SESSION_EXPIRES_HEADER)).toBe(false);
  });

  it('clears the cookie and drops revoked sessions from the cache straight away', async () => {
    let revoke = false;
    const { request, resolves } = await setup({
      upstream: () => ({
        status: 'ok',
        response: new Response(null, {
          status: 204,
          headers: revoke
            ? { [SESSION_CLEAR_HEADER]: '1', [REVOKED_SESSIONS_HEADER]: 's1, s2' }
            : {},
        }),
      }),
    });
    await request('/api/v1/me', { headers: signedIn });
    await request('/api/v1/me', { headers: signedIn });
    expect(resolves).toHaveLength(1);

    revoke = true;
    const logout = await request('/api/v1/me', { headers: signedIn });
    expect(logout.headers.get('set-cookie')).toContain(
      '__Host-qtiauth_session=; Path=/; Max-Age=0',
    );
    expect(logout.headers.has(REVOKED_SESSIONS_HEADER)).toBe(false);
    revoke = false;
    await request('/api/v1/me', { headers: signedIn });
    expect(resolves).toHaveLength(2);
  });

  it('keeps the flow binding in a cookie and hands it back only to identity', async () => {
    const binding = randomBytes(32).toString('base64url');
    const { request, forwarded } = await setup({
      upstream: () => ({
        status: 'ok',
        response: new Response(null, { status: 204, headers: { [FLOW_BINDING_HEADER]: binding } }),
      }),
    });
    const started = await request('/auth/login');
    expect(started.headers.get('set-cookie')).toBe(
      `__Host-qtiauth_session_flow=${binding}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
    );
    expect(started.headers.has(FLOW_BINDING_HEADER)).toBe(false);

    await request('/auth/login', {
      headers: {
        cookie: `__Host-qtiauth_session_flow=${binding}`,
        [FLOW_BINDING_HEADER]: 'spoofed',
      },
    });
    expect(forwarded[1]?.headers.get(FLOW_BINDING_HEADER)).toBe(binding);

    await request('/auth/login', { headers: { [FLOW_BINDING_HEADER]: binding } });
    expect(forwarded[2]?.headers.has(FLOW_BINDING_HEADER)).toBe(false);
  });

  it('does not hand the flow binding to other services', async () => {
    const binding = randomBytes(32).toString('base64url');
    const manifests: RouteManifest[] = [
      {
        service: 'notes',
        version: '1.0.0',
        permissions: [],
        notifications: [],
        routes: [route({ auth: 'none' })],
      },
    ];
    const { request, forwarded } = await setup({ manifests });
    await request('/api/v1/me', {
      headers: { cookie: `__Host-qtiauth_session_flow=${binding}` },
    });
    expect(forwarded[0]?.headers.has(FLOW_BINDING_HEADER)).toBe(false);
  });

  it('keeps the family dashboard token in a cookie and hands it back only to identity', async () => {
    const issued = randomBytes(32).toString('base64url');
    const { request, forwarded } = await setup({
      upstream: () => ({
        status: 'ok',
        response: new Response(null, {
          status: 204,
          headers: {
            [FAMILY_TOKEN_HEADER]: issued,
            [FAMILY_EXPIRES_HEADER]: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
      }),
    });
    const started = await request('/auth/login');
    expect(started.headers.get('set-cookie')).toMatch(
      new RegExp(
        `^__Host-qtiauth_session_family=${issued}; Path=/; Max-Age=(?:3599|3600); Secure; HttpOnly; SameSite=Lax$`,
      ),
    );
    expect(started.headers.has(FAMILY_TOKEN_HEADER)).toBe(false);

    await request('/auth/login', {
      headers: {
        cookie: `__Host-qtiauth_session_family=${issued}`,
        [FAMILY_TOKEN_HEADER]: 'spoofed',
      },
    });
    expect(forwarded[1]?.headers.get(FAMILY_TOKEN_HEADER)).toBe(issued);

    await request('/auth/login', { headers: { [FAMILY_TOKEN_HEADER]: issued } });
    expect(forwarded[2]?.headers.has(FAMILY_TOKEN_HEADER)).toBe(false);
  });

  it('clears the family dashboard cookie when identity asks', async () => {
    const { request } = await setup({
      upstream: () => ({
        status: 'ok',
        response: new Response(null, {
          status: 204,
          headers: { [FAMILY_CLEAR_HEADER]: '1' },
        }),
      }),
    });
    const response = await request('/auth/login');
    expect(response.headers.get('set-cookie')).toContain(
      '__Host-qtiauth_session_family=; Path=/; Max-Age=0',
    );
    expect(response.headers.has(FAMILY_CLEAR_HEADER)).toBe(false);
  });

  it('does not hand the family dashboard token to other services', async () => {
    const issued = randomBytes(32).toString('base64url');
    const manifests: RouteManifest[] = [
      {
        service: 'notes',
        version: '1.0.0',
        permissions: [],
        notifications: [],
        routes: [route({ auth: 'none' })],
      },
    ];
    const { request, forwarded } = await setup({ manifests });
    await request('/api/v1/me', {
      headers: { cookie: `__Host-qtiauth_session_family=${issued}` },
    });
    expect(forwarded[0]?.headers.has(FAMILY_TOKEN_HEADER)).toBe(false);
  });

  it('ignores session headers from services other than identity', async () => {
    const manifests: RouteManifest[] = [
      {
        service: 'notes',
        version: '1.0.0',
        permissions: [],
        notifications: [],
        routes: [route({ auth: 'none' })],
      },
    ];
    const { request, logs } = await setup({
      manifests,
      upstream: () => ({
        status: 'ok',
        response: new Response(null, {
          status: 204,
          headers: {
            [SESSION_TOKEN_HEADER]: randomBytes(32).toString('base64url'),
            [SESSION_EXPIRES_HEADER]: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
      }),
    });
    const response = await request('/api/v1/me');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has(SESSION_TOKEN_HEADER)).toBe(false);
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        message: 'ignored session headers from a service other than identity',
      }),
    );
  });

  it('never logs session tokens, cookies or identity tokens', async () => {
    const { request, forwarded, logs } = await setup();
    await request('/api/v1/me?token=secret-query', {
      headers: { ...signedIn, authorization: 'Bearer sekrit-bearer' },
    });
    expect(logs.lines.length).toBeGreaterThan(0);
    assertLogsScrubbed(logs.lines, [
      TOKEN,
      hashSessionToken(TOKEN),
      'sekrit-bearer',
      'secret-query',
      forwarded[0]?.headers.get(IDENTITY_HEADER) ?? 'missing',
    ]);
  });
});
