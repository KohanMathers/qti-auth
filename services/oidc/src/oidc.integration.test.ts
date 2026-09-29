import { createServer, type IncomingMessage, type Server } from 'node:http';

import { type Bus, connectBus, createEvent, publishEvent } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { IDENTITY_EVENTS } from '@qtiauth/events';
import {
  definition as gatewayDefinition,
  gatewayService,
  type RunningGateway,
} from '@qtiauth/gateway/testing';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import { type RunningService, serviceSchema, startService } from '@qtiauth/service-kit';
import { natsUrl, startNats, startPostgres, startValkey } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Database as IdentityDatabase } from '../../identity/src/database.ts';
import { definition as identityDefinition } from '../../identity/src/service.ts';
import { identityService } from '../../identity/src/start.ts';
import { type CapturedEmails, captureEmails } from '../../identity/src/testing.ts';
import type { Database } from './database.ts';
import { LOGOUT_EVENT } from './logout.ts';
import { pkceChallenge, pkceVerifier } from './pkce.ts';
import { suspendClient } from './portal.ts';
import { definition } from './service.ts';
import { oidcService } from './start.ts';

const ORIGIN = 'http://localhost:8000';
const COOKIE = '__Host-qtiauth_session';
const GAME = 'game';
const STUDIO = 'studio';
const SERVER = 'server';
const PAR_APP = 'par_app';
const LOGOUT_APP = 'logout_app';
const STUDIO_SECRET = 'studio-secret';
const SERVER_SECRET = 'server-secret';
const PAR_SECRET = 'par-secret';
const LOGOUT_SECRET = 'logout-secret';
const GAME_REDIRECT = 'http://127.0.0.1/callback';
const STUDIO_REDIRECT = 'https://app.example.com/callback';
const PAR_REDIRECT = 'https://par.example.com/callback';
const LOGOUT_REDIRECT = 'http://127.0.0.1/logout-callback';
const surfaces = {
  account: { hosts: ['localhost'], base_path: '/', origins: [ORIGIN] },
  support: { hosts: ['localhost'], base_path: '/support', origins: [ORIGIN] },
  api: { hosts: ['localhost'], base_path: '/api', origins: [ORIGIN] },
};

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let valkey: Awaited<ReturnType<typeof startValkey>>;
let notifier: Bus;
let emails: CapturedEmails;
let identity: RunningService<typeof identityDefinition, IdentityDatabase>;
let oidc: RunningService<typeof definition, Database>;
let gatewayRunning: RunningService<typeof gatewayDefinition>;
let gateway: RunningGateway;
const logs = captureLogs();
const secrets: string[] = [];
const logoutInbox: string[] = [];
let logoutReceiver: Server;
let logoutUri: string;

interface Browser {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  cookie: () => string | null;
  setCookie: (value: string | null) => void;
}

function browser(country = 'GB'): Browser {
  let cookie: string | null = null;
  const others = new Map<string, string>();
  return {
    cookie: () => cookie,
    setCookie: (value) => {
      cookie = value;
    },
    request: async (path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('cf-ipcountry', country);
      if (init.method !== undefined && init.method !== 'GET') headers.set('origin', ORIGIN);
      const jar = [...(cookie === null ? [] : [cookie]), ...others.values()];
      if (jar.length > 0) headers.set('cookie', jar.join('; '));
      const response = await fetch(`http://localhost:${String(gateway.ports[0])}${path}`, {
        ...init,
        headers,
        redirect: 'manual',
      });
      for (const set of response.headers.getSetCookie()) {
        const pair = set.split(';')[0] ?? '';
        const name = pair.slice(0, pair.indexOf('='));
        const value = pair.slice(name.length + 1);
        if (name === COOKIE) {
          cookie = value === '' ? null : pair;
          if (cookie !== null) secrets.push(value);
        } else if (value === '') {
          others.delete(name);
        } else {
          others.set(name, pair);
          if (name.endsWith('_flow') || name.endsWith('_family')) secrets.push(value);
        }
      }
      return response;
    },
  };
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  };
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function locationOf(response: Response): URL {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  return new URL(location ?? '', ORIGIN);
}

async function openLink(client: Browser, email: string): Promise<string> {
  const start = await client.request('/api/v1/auth/magic-link/start', json({ email }));
  expect(start.status).toBe(202);
  const link = await emails.nextLink(email);
  const token = link.searchParams.get('token') ?? '';
  secrets.push(token);
  const page = await client.request(`${link.pathname}${link.search}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('action="magic-link"');
  return token;
}

async function signUpInBrowser(
  client: Browser,
  email: string,
  dateOfBirth = '1990-02-03',
): Promise<void> {
  const token = await openLink(client, email);
  const confirm = await client.request('/auth/magic-link', form({ token }));
  const dobPage = await confirm.text();
  const signupToken = /name="signup_token" value="([^"]+)"/.exec(dobPage)?.[1] ?? '';
  expect(signupToken).not.toBe('');
  secrets.push(signupToken);
  const created = await client.request(
    '/auth/signup',
    form({ signup_token: signupToken, date_of_birth: dateOfBirth }),
  );
  expect(created.status).toBe(200);
  expect(await created.text()).toContain('You’re signed in');
  expect(client.cookie()).not.toBeNull();
}

const CHILD_DOB = `${String(new Date().getUTCFullYear() - 10)}-01-01`;

async function signUpChildWithGuardian(
  child: Browser,
  email: string,
  guardianEmail: string,
): Promise<string> {
  const token = await openLink(child, email);
  const confirm = await child.request('/auth/magic-link', form({ token }));
  const dobPage = await confirm.text();
  const signupToken = /name="signup_token" value="([^"]+)"/.exec(dobPage)?.[1] ?? '';
  expect(signupToken).not.toBe('');
  secrets.push(signupToken);
  const created = await child.request(
    '/auth/signup',
    form({
      signup_token: signupToken,
      date_of_birth: CHILD_DOB,
      guardian_email: guardianEmail,
    }),
  );
  expect(created.status).toBe(200);
  expect(await created.text()).toContain('We’ve emailed');
  expect(child.cookie()).not.toBeNull();
  const me = await child.request('/api/v1/me');
  expect(me.status).toBe(200);
  const account = (await me.json()) as { id: string };
  const job = await emails.nextJob(guardianEmail, 'parental_consent');
  const approveToken =
    new URL(String(job.variables['approve_link'])).searchParams.get('token') ?? '';
  secrets.push(approveToken);
  const approved = await child.request(
    '/api/v1/auth/parental-consent/approve',
    json({ token: approveToken, date_of_birth: '1980-01-01' }),
  );
  expect(approved.status).toBe(204);
  await vi.waitFor(
    async () => {
      const page = await child.request('/oauth/device');
      expect(page.status).toBe(200);
    },
    { timeout: 10_000 },
  );
  return account.id;
}

async function openFamily(guardianEmail: string): Promise<Browser> {
  const guardian = browser();
  const start = await guardian.request(
    '/api/v1/auth/family/magic-link',
    json({ email: guardianEmail }),
  );
  expect(start.status).toBe(202);
  const job = await emails.nextJob(guardianEmail, 'family_access');
  const familyToken = new URL(String(job.variables['link'])).searchParams.get('token') ?? '';
  secrets.push(familyToken);
  const opened = await guardian.request(
    '/api/v1/auth/family/session',
    json({ token: familyToken }),
  );
  expect(opened.status).toBe(200);
  return guardian;
}

async function pendingStudioApproval(
  guardian: Browser,
  childId: string,
): Promise<{ id: string; name: string }> {
  const detail = await guardian.request(`/api/v1/family/${childId}`);
  expect(detail.status).toBe(200);
  const body = (await detail.json()) as {
    pending_app_approvals: { id: string; name: string }[];
  };
  expect(body.pending_app_approvals[0]?.name).toBe('Studio');
  const pending = body.pending_app_approvals[0];
  expect(pending).toBeDefined();
  return { id: pending?.id ?? '', name: pending?.name ?? '' };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = pkceVerifier();
  secrets.push(verifier);
  return { verifier, challenge: pkceChallenge(verifier) };
}

function authorizePath(
  clientId: string,
  redirectUri: string,
  challenge: string,
  scope = 'openid profile email offline_access',
): string {
  return `/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: 'state-1',
    nonce: 'nonce-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()}`;
}

async function exchangeCode(
  client: Browser,
  options: {
    clientId: string;
    redirectUri: string;
    code: string;
    verifier: string;
    secret?: string;
  },
): Promise<{
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  scope: string;
}> {
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    code: options.code,
    code_verifier: options.verifier,
  };
  if (options.secret !== undefined) fields['client_secret'] = options.secret;
  const response = await client.request('/oauth/token', form(fields));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    token_type: string;
    scope: string;
  };
  secrets.push(body.access_token);
  if (body.refresh_token !== undefined) secrets.push(body.refresh_token);
  if (body.id_token !== undefined) secrets.push(body.id_token);
  return body;
}

function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function jwtHeader(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function listenLogout(): Promise<Server> {
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const token = new URLSearchParams(body).get('logout_token');
      if (token !== null) {
        logoutInbox.push(token);
        secrets.push(token);
      }
      response.statusCode = 200;
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

beforeAll(async () => {
  [postgres, nats, valkey] = await Promise.all([startPostgres(), startNats(), startValkey()]);
  logoutReceiver = await listenLogout();
  const address = logoutReceiver.address();
  if (address === null || typeof address === 'string') {
    throw new Error('logout receiver has no port');
  }
  logoutUri = `http://127.0.0.1:${String(address.port)}/backchannel`;
  const observability = {
    logs: { user_id_hash_key: 'integration' },
    metrics: { process_metrics: false },
  };
  notifier = await connectBus(sections.bus.parse({ servers: [natsUrl(nats)] }), 'notifier');
  emails = await captureEmails(notifier);

  identity = await startService(identityDefinition, {
    ...identityService(),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    config: serviceSchema(identityDefinition).parse({
      bus: { servers: [natsUrl(nats)] },
      valkey: { host: valkey.getHost(), port: valkey.getPort() },
      database: {
        host: postgres.getHost(),
        port: postgres.getPort(),
        name: postgres.getDatabase(),
        roles: { identity: { user: postgres.getUsername(), password: postgres.getPassword() } },
      },
      observability,
      surfaces,
      password: {
        argon2: { memory_kib: 8, iterations: 1 },
        breach_check: false,
        failure_delay: { step: '1ms', max: '1ms' },
      },
      captcha: { after: 1000, altcha: { hmac_key: 'integration-captcha-key', max_number: 400 } },
      security: { encryption_key: Buffer.alloc(32, 9).toString('base64') },
      geoip: { source: 'header', header: 'cf-ipcountry' },
    }),
  });

  oidc = await startService(definition, {
    ...oidcService({ logoutPollInterval: 50 }),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    config: serviceSchema(definition).parse({
      bus: { servers: [natsUrl(nats)] },
      database: {
        host: postgres.getHost(),
        port: postgres.getPort(),
        name: postgres.getDatabase(),
        roles: { oidc: { user: postgres.getUsername(), password: postgres.getPassword() } },
      },
      observability,
      surfaces,
      oidc: {
        issuer: ORIGIN,
        signing: { encryption_key: Buffer.alloc(32, 5).toString('base64') },
        device_interval: '1ms',
        clients: {
          [GAME]: {
            name: 'Game',
            type: 'public',
            first_party: true,
            redirect_uris: [GAME_REDIRECT],
          },
          [STUDIO]: {
            name: 'Studio',
            type: 'confidential',
            first_party: false,
            redirect_uris: [STUDIO_REDIRECT],
            secret: STUDIO_SECRET,
          },
          [SERVER]: {
            name: 'Game server',
            type: 'confidential',
            first_party: true,
            allowed_scopes: ['games'],
            secret: SERVER_SECRET,
          },
          [PAR_APP]: {
            name: 'PAR App',
            type: 'confidential',
            first_party: true,
            require_par: true,
            redirect_uris: [PAR_REDIRECT],
            secret: PAR_SECRET,
          },
          [LOGOUT_APP]: {
            name: 'Logout App',
            type: 'confidential',
            first_party: true,
            redirect_uris: [LOGOUT_REDIRECT],
            secret: LOGOUT_SECRET,
            backchannel_logout_uri: logoutUri,
            backchannel_logout_session_required: true,
          },
        },
      },
    }),
  });

  const service = gatewayService({ hostPort: 0 });
  gatewayRunning = await startService(gatewayDefinition, {
    ...service.options,
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    config: serviceSchema(gatewayDefinition).parse({
      bus: { servers: [natsUrl(nats)] },
      valkey: { host: valkey.getHost(), port: valkey.getPort() },
      observability,
      surfaces,
      geoip: { source: 'header', header: 'cf-ipcountry' },
      gateway: {
        identity_keys: { encryption_key: Buffer.alloc(32, 7).toString('base64') },
        discovery: { interval: '500ms', expiry: '5s', startup_grace: '1ms' },
        upstreams: { identity: identity.url, oidc: oidc.url },
      },
    }),
  });
  gateway = service.gateway();
  await vi.waitFor(
    () => {
      expect(gateway.registry.isRunning('identity')).toBe(true);
      expect(gateway.registry.isRunning('oidc')).toBe(true);
    },
    { timeout: 10_000 },
  );
});

afterAll(async () => {
  await (gatewayRunning as RunningService<typeof gatewayDefinition> | undefined)?.stop();
  await (oidc as typeof oidc | undefined)?.stop();
  await (identity as typeof identity | undefined)?.stop();
  await (emails as typeof emails | undefined)?.stop();
  await (notifier as Bus | undefined)?.close();
  const receiver = logoutReceiver as Server | undefined;
  if (receiver) {
    await new Promise<void>((resolve, reject) => {
      receiver.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  await Promise.all([
    (postgres as typeof postgres | undefined)?.stop(),
    (nats as typeof nats | undefined)?.stop(),
    (valkey as typeof valkey | undefined)?.stop(),
  ]);
  assertLogsScrubbed(logs.lines, secrets);
});

describe('oidc through the gateway', () => {
  it('publishes discovery and JWKS', async () => {
    const client = browser();
    const discovery = await client.request('/.well-known/openid-configuration');
    expect(discovery.status).toBe(200);
    const document = (await discovery.json()) as {
      issuer: string;
      authorization_endpoint: string;
      device_authorization_endpoint: string;
      pushed_authorization_request_endpoint: string;
      grant_types_supported: string[];
      code_challenge_methods_supported: string[];
      scopes_supported: string[];
    };
    expect(document.issuer).toBe(ORIGIN);
    expect(document.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(document.device_authorization_endpoint).toBe(`${ORIGIN}/oauth/device_authorization`);
    expect(document.pushed_authorization_request_endpoint).toBe(`${ORIGIN}/oauth/par`);
    expect(document).toMatchObject({
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
    });
    expect(document.grant_types_supported).toEqual(
      expect.arrayContaining([
        'authorization_code',
        'refresh_token',
        'client_credentials',
        'urn:ietf:params:oauth:grant-type:device_code',
      ]),
    );
    expect(document.code_challenge_methods_supported).toEqual(['S256']);
    expect(document.scopes_supported).toEqual(
      expect.arrayContaining(['openid', 'email', 'age', 'parental_controls', 'restrictions']),
    );

    const jwks = await client.request('/.well-known/jwks.json');
    expect(jwks.status).toBe(200);
    const keys = (await jwks.json()) as { keys: { kid: string; kty: string }[] };
    expect(keys.keys.length).toBeGreaterThan(0);
    expect(keys.keys[0]?.kty).toBe('EC');
  });

  it('issues tokens for a first-party client without a consent screen', async () => {
    const client = browser();
    await signUpInBrowser(client, 'player@example.com');
    const { verifier, challenge } = pkce();
    const authorize = await client.request(authorizePath(GAME, GAME_REDIRECT, challenge));
    expect(authorize.status).toBe(302);
    const redirected = locationOf(authorize);
    expect(redirected.origin).toBe('http://127.0.0.1');
    expect(redirected.pathname).toBe('/callback');
    expect(redirected.searchParams.get('state')).toBe('state-1');
    const code = redirected.searchParams.get('code') ?? '';
    expect(code).not.toBe('');
    secrets.push(code);

    const tokens = await exchangeCode(client, {
      clientId: GAME,
      redirectUri: GAME_REDIRECT,
      code,
      verifier,
    });
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.id_token).toBeDefined();
    expect(tokens.refresh_token).toBeDefined();
    expect(tokens.scope.split(' ')).toEqual(
      expect.arrayContaining(['openid', 'profile', 'email', 'offline_access']),
    );

    const userinfo = await client.request('/oauth/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userinfo.status).toBe(200);
    expect(await userinfo.json()).toMatchObject({
      email: 'player@example.com',
      email_verified: true,
    });

    const me = await client.request('/api/v1/me');
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'player@example.com' });

    const bearerOnly = browser();
    const rejected = await bearerOnly.request('/api/v1/me', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });

    const reused = await client.request(
      '/oauth/token',
      form({
        grant_type: 'authorization_code',
        client_id: GAME,
        redirect_uri: GAME_REDIRECT,
        code,
        code_verifier: verifier,
      }),
    );
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('asks for consent on a third-party client and stores it', async () => {
    const client = browser();
    await signUpInBrowser(client, 'adult@example.com');
    const { verifier, challenge } = pkce();
    const authorize = await client.request(authorizePath(STUDIO, STUDIO_REDIRECT, challenge));
    expect(authorize.status).toBe(302);
    const consent = locationOf(authorize);
    expect(consent.pathname).toBe('/oauth/consent');
    const requestId = consent.searchParams.get('request_id') ?? '';
    expect(requestId).not.toBe('');

    const page = await client.request(`${consent.pathname}${consent.search}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Studio wants to');
    expect(html).toContain('Unverified app');

    const allowed = await client.request(
      '/oauth/consent',
      form({ request_id: requestId, decision: 'allow' }),
    );
    expect(allowed.status).toBe(302);
    const redirected = locationOf(allowed);
    expect(redirected.origin).toBe('https://app.example.com');
    const code = redirected.searchParams.get('code') ?? '';
    secrets.push(code);

    const tokens = await exchangeCode(client, {
      clientId: STUDIO,
      redirectUri: STUDIO_REDIRECT,
      code,
      verifier,
      secret: STUDIO_SECRET,
    });

    const listed = await client.request('/api/v1/oauth/authorized');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      items: [expect.objectContaining({ client_id: STUDIO, name: 'Studio' })],
    });

    const introspect = await client.request(
      '/oauth/introspect',
      form({
        token: tokens.access_token,
        client_id: STUDIO,
        client_secret: STUDIO_SECRET,
      }),
    );
    expect(introspect.status).toBe(200);
    expect(await introspect.json()).toMatchObject({
      active: true,
      token_type: 'Bearer',
      client_id: STUDIO,
    });

    const again = await client.request(authorizePath(STUDIO, STUDIO_REDIRECT, pkce().challenge));
    expect(again.status).toBe(302);
    expect(locationOf(again).searchParams.get('code')).toBeTruthy();
  });

  it('refuses a child account authorizing a non-first-party client', async () => {
    const client = browser();
    await signUpInBrowser(client, 'child@example.com', '2011-01-01');
    const authorize = await client.request(
      authorizePath(STUDIO, STUDIO_REDIRECT, pkce().challenge),
    );
    expect(authorize.status).toBe(302);
    const redirected = locationOf(authorize);
    expect(redirected.searchParams.get('error')).toBe('access_denied');
  });

  it('holds a child’s third-party authorization until a guardian approves', async () => {
    const child = browser();
    const childId = await signUpChildWithGuardian(
      child,
      'guardian-child@example.com',
      'guardian-parent@example.com',
    );
    const guardian = await openFamily('guardian-parent@example.com');
    const { verifier, challenge } = pkce();
    const authorize = await child.request(authorizePath(STUDIO, STUDIO_REDIRECT, challenge));
    expect(authorize.status).toBe(302);
    const consentUrl = locationOf(authorize);
    expect(consentUrl.pathname).toBe('/oauth/consent');
    const waiting = await child.request(`${consentUrl.pathname}${consentUrl.search}`);
    expect(waiting.status).toBe(200);
    expect(await waiting.text()).toContain('Waiting for a parent or guardian');
    await emails.nextJob('guardian-parent@example.com', 'guardian_app_approval');

    const pending = await pendingStudioApproval(guardian, childId);
    const approved = await guardian.request(
      `/api/v1/family/${childId}/app-approvals/${pending.id}/approve`,
      { method: 'POST' },
    );
    expect(approved.status).toBe(204);

    const finished = await child.request(`${consentUrl.pathname}${consentUrl.search}`);
    expect(finished.status).toBe(302);
    const code = locationOf(finished).searchParams.get('code') ?? '';
    secrets.push(code);
    expect(code).not.toBe('');
    await exchangeCode(child, {
      clientId: STUDIO,
      redirectUri: STUDIO_REDIRECT,
      code,
      verifier,
      secret: STUDIO_SECRET,
    });
    await emails.nextJob('guardian-parent@example.com', 'guardian_new_app');

    const activity = await guardian.request(`/api/v1/family/${childId}/activity`);
    expect(activity.status).toBe(200);
    const summary = (await activity.json()) as { connected_apps: { name: string }[] };
    expect(summary.connected_apps.map((app) => app.name)).toEqual(['Studio']);
  });

  it('tells the client access_denied when a guardian declines the app', async () => {
    const child = browser();
    const childId = await signUpChildWithGuardian(
      child,
      'deny-child@example.com',
      'deny-parent@example.com',
    );
    const guardian = await openFamily('deny-parent@example.com');
    const authorize = await child.request(authorizePath(STUDIO, STUDIO_REDIRECT, pkce().challenge));
    expect(authorize.status).toBe(302);
    const consentUrl = locationOf(authorize);
    const waiting = await child.request(`${consentUrl.pathname}${consentUrl.search}`);
    expect(waiting.status).toBe(200);
    await emails.nextJob('deny-parent@example.com', 'guardian_app_approval');

    const pending = await pendingStudioApproval(guardian, childId);
    const declined = await guardian.request(
      `/api/v1/family/${childId}/app-approvals/${pending.id}/decline`,
      { method: 'POST' },
    );
    expect(declined.status).toBe(204);

    const finished = await child.request(`${consentUrl.pathname}${consentUrl.search}`);
    expect(finished.status).toBe(302);
    expect(locationOf(finished).searchParams.get('error')).toBe('access_denied');
  });

  it('keeps a child’s device flow pending until a guardian approves', async () => {
    const device = browser();
    const started = await device.request(
      '/oauth/device_authorization',
      form({
        client_id: STUDIO,
        client_secret: STUDIO_SECRET,
        scope: 'openid',
      }),
    );
    expect(started.status).toBe(200);
    const codes = (await started.json()) as {
      device_code: string;
      user_code: string;
    };
    secrets.push(codes.device_code, codes.user_code);

    const child = browser();
    const childId = await signUpChildWithGuardian(
      child,
      'device-child@example.com',
      'device-parent@example.com',
    );
    const guardian = await openFamily('device-parent@example.com');
    const confirm = await child.request(
      `/oauth/device?user_code=${encodeURIComponent(codes.user_code)}`,
    );
    expect(confirm.status).toBe(200);
    const allowed = await child.request(
      '/oauth/device',
      form({ user_code: codes.user_code, decision: 'allow' }),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('Waiting for a parent or guardian');
    await emails.nextJob('device-parent@example.com', 'guardian_app_approval');

    const pendingPoll = await device.request(
      '/oauth/token',
      form({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: STUDIO,
        client_secret: STUDIO_SECRET,
        device_code: codes.device_code,
      }),
    );
    expect(pendingPoll.status).toBe(400);
    expect(await pendingPoll.json()).toMatchObject({ error: 'authorization_pending' });

    const pending = await pendingStudioApproval(guardian, childId);
    const approved = await guardian.request(
      `/api/v1/family/${childId}/app-approvals/${pending.id}/approve`,
      { method: 'POST' },
    );
    expect(approved.status).toBe(204);

    const tokens = await device.request(
      '/oauth/token',
      form({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: STUDIO,
        client_secret: STUDIO_SECRET,
        device_code: codes.device_code,
      }),
    );
    expect(tokens.status).toBe(200);
    const body = (await tokens.json()) as { access_token: string };
    secrets.push(body.access_token);
  });

  it('rotates refresh tokens and revokes the family after reuse', async () => {
    const client = browser();
    await signUpInBrowser(client, 'refresh@example.com');
    const { verifier, challenge } = pkce();
    const authorize = await client.request(authorizePath(GAME, GAME_REDIRECT, challenge));
    const code = locationOf(authorize).searchParams.get('code') ?? '';
    secrets.push(code);
    const first = await exchangeCode(client, {
      clientId: GAME,
      redirectUri: GAME_REDIRECT,
      code,
      verifier,
    });
    expect(first.refresh_token).toBeDefined();

    const rotated = await client.request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        client_id: GAME,
        refresh_token: first.refresh_token ?? '',
      }),
    );
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { access_token: string; refresh_token: string };
    secrets.push(next.access_token, next.refresh_token);
    expect(next.refresh_token).not.toBe(first.refresh_token);

    const reuse = await client.request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        client_id: GAME,
        refresh_token: first.refresh_token ?? '',
      }),
    );
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: 'invalid_grant' });

    const afterReuse = await client.request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        client_id: GAME,
        refresh_token: next.refresh_token,
      }),
    );
    expect(afterReuse.status).toBe(400);

    const userinfo = await client.request('/oauth/userinfo', {
      headers: { authorization: `Bearer ${next.access_token}` },
    });
    expect(userinfo.status).toBe(401);
  });

  it('revokes an access token so userinfo and introspection stop working', async () => {
    const client = browser();
    await signUpInBrowser(client, 'revoke@example.com');
    const { verifier, challenge } = pkce();
    const authorize = await client.request(
      authorizePath(STUDIO, STUDIO_REDIRECT, challenge, 'openid'),
    );
    const consent = locationOf(authorize);
    const requestId = consent.searchParams.get('request_id') ?? '';
    const allowed = await client.request(
      '/oauth/consent',
      form({ request_id: requestId, decision: 'allow' }),
    );
    const code = locationOf(allowed).searchParams.get('code') ?? '';
    secrets.push(code);
    const tokens = await exchangeCode(client, {
      clientId: STUDIO,
      redirectUri: STUDIO_REDIRECT,
      code,
      verifier,
      secret: STUDIO_SECRET,
    });

    const revoked = await client.request(
      '/oauth/revoke',
      form({
        token: tokens.access_token,
        token_type_hint: 'access_token',
        client_id: STUDIO,
        client_secret: STUDIO_SECRET,
      }),
    );
    expect(revoked.status).toBe(200);

    const userinfo = await client.request('/oauth/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userinfo.status).toBe(401);

    const introspect = await client.request(
      '/oauth/introspect',
      form({
        token: tokens.access_token,
        client_id: STUDIO,
        client_secret: STUDIO_SECRET,
      }),
    );
    expect(await introspect.json()).toEqual({ active: false });
  });

  it('rejects an OAuth access token on every session route', async () => {
    const client = browser();
    await signUpInBrowser(client, 'separate@example.com');
    const { verifier, challenge } = pkce();
    const authorize = await client.request(authorizePath(GAME, GAME_REDIRECT, challenge, 'openid'));
    const code = locationOf(authorize).searchParams.get('code') ?? '';
    secrets.push(code);
    const tokens = await exchangeCode(client, {
      clientId: GAME,
      redirectUri: GAME_REDIRECT,
      code,
      verifier,
    });

    const anonymous = browser();
    const sessionRoutes = gateway
      .routes()
      .mounts.filter((mount) => mount.route.route.auth === 'session');
    expect(sessionRoutes.length).toBeGreaterThan(0);
    const bases = { account: '', support: '/support', api: '/api' } as const;
    for (const mount of sessionRoutes) {
      const mounted = `${bases[mount.surface]}${mount.path}`;
      const path = mounted.includes(':')
        ? mounted.replaceAll(/:[^/]+/g, '0199a0e0-0000-7000-8000-000000000001')
        : mounted;
      const response = await anonymous.request(path, {
        method: mount.method,
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          ...(mount.method === 'GET' ? {} : { 'content-type': 'application/json' }),
        },
        ...(mount.method === 'GET' ? {} : { body: '{}' }),
      });
      expect(response.status, `${mount.method} ${path}`).not.toBe(200);
      if (response.status === 401) {
        expect(await response.json(), `${mount.method} ${path}`).toMatchObject({
          code: 'AUTHENTICATION_REQUIRED',
        });
      } else if (response.status === 302) {
        expect(locationOf(response).pathname, `${mount.method} ${path}`).toBe('/auth/login');
      }
    }
  });

  it('lets a CLI sign in with the device flow', async () => {
    const device = browser();
    const started = await device.request(
      '/oauth/device_authorization',
      form({
        client_id: GAME,
        scope: 'openid profile',
      }),
    );
    expect(started.status).toBe(200);
    const codes = (await started.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      interval: number;
    };
    secrets.push(codes.device_code, codes.user_code);
    expect(codes.verification_uri).toBe(`${ORIGIN}/oauth/device`);
    expect(codes.interval).toBe(0);

    const pending = await device.request(
      '/oauth/token',
      form({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: GAME,
        device_code: codes.device_code,
      }),
    );
    expect(pending.status).toBe(400);
    expect(await pending.json()).toMatchObject({ error: 'authorization_pending' });

    const user = browser();
    await signUpInBrowser(user, 'cli@example.com');
    const confirm = await user.request(
      `/oauth/device?user_code=${encodeURIComponent(codes.user_code)}`,
    );
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain('Game wants to');
    const allowed = await user.request(
      '/oauth/device',
      form({ user_code: codes.user_code, decision: 'allow' }),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('You can return to your device');

    const tokens = await device.request(
      '/oauth/token',
      form({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: GAME,
        device_code: codes.device_code,
      }),
    );
    expect(tokens.status).toBe(200);
    const body = (await tokens.json()) as { access_token: string; id_token?: string };
    secrets.push(body.access_token);
    if (body.id_token !== undefined) secrets.push(body.id_token);

    const userinfo = await device.request('/oauth/userinfo', {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(userinfo.status).toBe(200);
    expect(await userinfo.json()).toMatchObject({ email: 'cli@example.com' });
  });

  it('issues a service token that cannot reach a user-session route', async () => {
    const client = browser();
    const issued = await client.request(
      '/oauth/token',
      form({
        grant_type: 'client_credentials',
        client_id: SERVER,
        client_secret: SERVER_SECRET,
        scope: 'games',
      }),
    );
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as { access_token: string; refresh_token?: string };
    secrets.push(body.access_token);
    expect(body.refresh_token).toBeUndefined();

    const me = await client.request('/api/v1/me', {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });

    const userinfo = await client.request('/oauth/userinfo', {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(userinfo.status).toBe(401);

    const recognized = await client.request('/api/v1/oauth/client', {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(recognized.status).toBe(200);
    expect(await recognized.json()).toMatchObject({ client_id: SERVER, scopes: ['games'] });

    const publicClient = await client.request(
      '/oauth/token',
      form({
        grant_type: 'client_credentials',
        client_id: GAME,
        scope: 'games',
      }),
    );
    expect(publicClient.status).toBe(400);
    expect(await publicClient.json()).toMatchObject({ error: 'unauthorized_client' });
  });

  it('requires pushed authorization when the client is configured for it', async () => {
    const client = browser();
    await signUpInBrowser(client, 'par@example.com');
    const { verifier, challenge } = pkce();
    const direct = await client.request(authorizePath(PAR_APP, PAR_REDIRECT, challenge, 'openid'));
    expect(direct.status).toBe(302);
    const denied = locationOf(direct);
    expect(denied.origin).toBe('https://par.example.com');
    expect(denied.searchParams.get('error')).toBe('invalid_request');

    const pushed = await client.request(
      '/oauth/par',
      form({
        client_id: PAR_APP,
        client_secret: PAR_SECRET,
        response_type: 'code',
        redirect_uri: PAR_REDIRECT,
        scope: 'openid',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    );
    expect(pushed.status).toBe(201);
    const handle = (await pushed.json()) as { request_uri: string; expires_in: number };
    expect(handle.request_uri).toMatch(/^urn:ietf:params:oauth:request_uri:/);
    secrets.push(handle.request_uri);

    const authorize = await client.request(
      `/oauth/authorize?${new URLSearchParams({
        client_id: PAR_APP,
        request_uri: handle.request_uri,
      }).toString()}`,
    );
    expect(authorize.status).toBe(302);
    const redirected = locationOf(authorize);
    expect(redirected.origin).toBe('https://par.example.com');
    const code = redirected.searchParams.get('code') ?? '';
    secrets.push(code);
    const tokens = await exchangeCode(client, {
      clientId: PAR_APP,
      redirectUri: PAR_REDIRECT,
      code,
      verifier,
      secret: PAR_SECRET,
    });
    expect(tokens.id_token).toBeDefined();
  });

  it('POSTs a logout token when the user signs out on another surface', async () => {
    const client = browser();
    await signUpInBrowser(client, 'logout@example.com');
    const me = (await (await client.request('/api/v1/me')).json()) as { id: string };
    const { verifier, challenge } = pkce();
    logoutInbox.length = 0;
    const authorize = await client.request(authorizePath(LOGOUT_APP, LOGOUT_REDIRECT, challenge));
    const code = locationOf(authorize).searchParams.get('code') ?? '';
    secrets.push(code);
    const tokens = await exchangeCode(client, {
      clientId: LOGOUT_APP,
      redirectUri: LOGOUT_REDIRECT,
      code,
      verifier,
      secret: LOGOUT_SECRET,
    });
    expect(tokens.refresh_token).toBeDefined();

    const signedOut = await client.request('/support/api/v1/auth/logout', { method: 'POST' });
    expect(signedOut.status).toBe(204);

    await vi.waitFor(
      () => {
        expect(logoutInbox.length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    const token = logoutInbox[0] ?? '';
    expect(jwtHeader(token)).toMatchObject({ typ: 'logout+jwt', alg: 'ES256' });
    const payload = jwtPayload(token);
    expect(payload).toMatchObject({
      iss: ORIGIN,
      aud: LOGOUT_APP,
      sub: me.id,
      events: { [LOGOUT_EVENT]: {} },
    });
    expect(typeof payload['sid']).toBe('string');
    expect(typeof payload['jti']).toBe('string');
    expect(payload).not.toHaveProperty('nonce');

    const userinfo = await client.request('/oauth/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userinfo.status).toBe(401);

    const refreshed = await client.request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token ?? '',
        client_id: LOGOUT_APP,
        client_secret: LOGOUT_SECRET,
      }),
    );
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    secrets.push(next.access_token);
  });

  it('revokes offline_access refresh tokens when the account is banned', async () => {
    const client = browser();
    await signUpInBrowser(client, 'banned-oidc@example.com');
    const me = (await (await client.request('/api/v1/me')).json()) as { id: string };
    const { verifier, challenge } = pkce();
    logoutInbox.length = 0;
    const authorize = await client.request(authorizePath(LOGOUT_APP, LOGOUT_REDIRECT, challenge));
    const code = locationOf(authorize).searchParams.get('code') ?? '';
    secrets.push(code);
    const tokens = await exchangeCode(client, {
      clientId: LOGOUT_APP,
      redirectUri: LOGOUT_REDIRECT,
      code,
      verifier,
      secret: LOGOUT_SECRET,
    });

    await publishEvent(
      notifier.js,
      createEvent({
        type: IDENTITY_EVENTS.userBanned,
        actor: { type: 'user', id: me.id },
        subject: { type: 'user', id: me.id },
        data: { reason: 'spam' },
      }),
    );

    await vi.waitFor(
      () => {
        expect(logoutInbox.length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    expect(jwtPayload(logoutInbox[0] ?? '')).toMatchObject({
      aud: LOGOUT_APP,
      sub: me.id,
    });

    const refreshed = await client.request(
      '/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token ?? '',
        client_id: LOGOUT_APP,
        client_secret: LOGOUT_SECRET,
      }),
    );
    expect(refreshed.status).toBe(400);
    expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('invalidates live tokens on the next introspection and JWT check after a client is suspended', async () => {
    const client = browser();
    await signUpInBrowser(client, 'portal-suspend@example.com');
    const created = await client.request(
      '/api/v1/oauth/clients',
      json({
        name: 'Suspend Me',
        type: 'confidential',
        redirect_uris: ['http://127.0.0.1/portal-callback'],
      }),
    );
    expect(created.status).toBe(201);
    const app = (await created.json()) as { client_id: string; secret: string };
    secrets.push(app.secret);

    const { verifier, challenge } = pkce();
    const authorize = await client.request(
      authorizePath(app.client_id, 'http://127.0.0.1/portal-callback', challenge, 'openid'),
    );
    expect(authorize.status).toBe(302);
    const consent = locationOf(authorize);
    const requestId = consent.searchParams.get('request_id') ?? '';
    const page = await client.request(`${consent.pathname}${consent.search}`);
    expect(await page.text()).toContain('Unverified app');
    const allowed = await client.request(
      '/oauth/consent',
      form({ request_id: requestId, decision: 'allow' }),
    );
    const code = locationOf(allowed).searchParams.get('code') ?? '';
    secrets.push(code);
    const tokens = await exchangeCode(client, {
      clientId: app.client_id,
      redirectUri: 'http://127.0.0.1/portal-callback',
      code,
      verifier,
      secret: app.secret,
    });

    const live = await client.request('/oauth/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(live.status).toBe(200);

    const result = await suspendClient(oidc.context.db, {
      clientId: app.client_id,
      actor: { type: 'system', id: 'oidc' },
      now: new Date(),
    });
    expect(result.status).toBe('ok');
    oidc.context.outbox.wake();

    const userinfo = await client.request('/oauth/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userinfo.status).toBe(401);

    const introspect = await client.request(
      '/oauth/introspect',
      form({
        token: tokens.access_token,
        client_id: app.client_id,
        client_secret: app.secret,
      }),
    );
    expect(introspect.status).toBe(401);
    expect(await introspect.json()).toMatchObject({ error: 'invalid_client' });
  });
});
