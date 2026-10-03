import { request as httpRequest } from 'node:http';

import { type Bus, connectBus } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import {
  definition as gatewayDefinition,
  gatewayService,
  type RunningGateway,
} from '@qtiauth/gateway/testing';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import { type RunningService, serviceSchema, startService } from '@qtiauth/service-kit';
import { natsUrl, startNats, startPostgres, startValkey } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Database } from './database.ts';
import { definition } from './service.ts';
import { identityService } from './start.ts';
import { type CapturedEmails, captureEmails } from './testing.ts';

const ACCOUNT = 'account.example.co.uk';
const SUPPORT = 'support.example.com';
const API = 'auth.example.co.uk';
const COOKIE = '__Host-qtiauth_session';
const BOUND = '__Host-qtiauth_session_bound';
const surfaces = {
  account: { hosts: [ACCOUNT], base_path: '/', origins: [`http://${ACCOUNT}`] },
  support: { hosts: [SUPPORT], base_path: '/', origins: [`http://${SUPPORT}`] },
  api: { hosts: [API], base_path: '/', origins: [`http://${API}`] },
};

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let valkey: Awaited<ReturnType<typeof startValkey>>;
let notifier: Bus;
let emails: CapturedEmails;
let identity: RunningService<typeof definition, Database>;
let gatewayRunning: RunningService<typeof gatewayDefinition>;
let gateway: RunningGateway;
const logs = captureLogs();
const secrets: string[] = [];

function port(): number {
  return gateway.ports[0] ?? 0;
}

function send(
  path: string,
  method: string,
  headers: Headers,
  body: string | undefined,
): Promise<Response> {
  if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)));
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: '127.0.0.1', port: port(), path, method, headers: Object.fromEntries(headers) },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            for (const item of Array.isArray(value) ? value : [value ?? '']) {
              responseHeaders.append(name, item);
            }
          }
          const status = incoming.statusCode ?? 0;
          const empty = status === 204 || status === 304;
          resolve(
            new Response(empty ? null : Buffer.concat(chunks), {
              status,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

class Browser {
  readonly cookies = new Map<string, string>();

  cookie(host: string, name: string): string | undefined {
    return this.cookies.get(`${host}:${name}`);
  }

  async request(host: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('host', host);
    if (!headers.has('accept')) headers.set('accept', 'text/html');
    if (init.method !== undefined && init.method !== 'GET') {
      headers.set('origin', `http://${host}`);
    }
    const jar = [...this.cookies.entries()]
      .filter(([key]) => key.startsWith(`${host}:`))
      .map(([key, value]) => `${key.slice(host.length + 1)}=${value}`);
    if (jar.length > 0) headers.set('cookie', jar.join('; '));
    const response = await send(
      path,
      init.method ?? 'GET',
      headers,
      typeof init.body === 'string' ? init.body : undefined,
    );
    for (const set of response.headers.getSetCookie()) {
      const pair = set.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === '') this.cookies.delete(`${host}:${name}`);
      else {
        this.cookies.set(`${host}:${name}`, value);
        if (name === COOKIE) secrets.push(value);
      }
    }
    return response;
  }

  async follow(response: Response): Promise<Response> {
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location ?? '', 'http://localhost');
    return this.request(url.hostname, `${url.pathname}${url.search}`);
  }
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function signUp(client: Browser, email: string): Promise<void> {
  const start = await client.request(ACCOUNT, '/api/v1/auth/magic-link/start', json({ email }));
  expect(start.status).toBe(202);
  const link = await emails.nextLink(email);
  const token = link.searchParams.get('token') ?? '';
  secrets.push(token);
  const verified = await client.request(ACCOUNT, '/api/v1/auth/magic-link/verify', json({ token }));
  expect(verified.status).toBe(200);
  const { signup_token: signupToken } = (await verified.json()) as { signup_token: string };
  secrets.push(signupToken);
  const created = await client.request(
    ACCOUNT,
    '/api/v1/auth/magic-link/signup',
    json({ signup_token: signupToken, date_of_birth: '1990-02-03' }),
  );
  expect(created.status).toBe(201);
  expect(client.cookie(ACCOUNT, COOKIE)).toBeTruthy();
}

beforeAll(async () => {
  [postgres, nats, valkey] = await Promise.all([startPostgres(), startNats(), startValkey()]);
  const bus = sections.bus.parse({ servers: [natsUrl(nats)] });
  notifier = await connectBus(bus, 'notifier');
  emails = await captureEmails(notifier);
  const observability = {
    logs: { user_id_hash_key: 'integration' },
    metrics: { process_metrics: false },
  };
  identity = await startService(definition, {
    ...identityService({ statsInterval: 200 }),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    config: serviceSchema(definition).parse({
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
      gateway: {
        identity_keys: { encryption_key: Buffer.alloc(32, 7).toString('base64') },
        discovery: { interval: '500ms', expiry: '5s', startup_grace: '1ms' },
        upstreams: { identity: identity.url },
      },
    }),
  });
  gateway = service.gateway();
  await vi.waitFor(
    () => {
      expect(gateway.registry.isRunning('identity')).toBe(true);
    },
    { timeout: 10_000 },
  );
});

afterAll(async () => {
  await gatewayRunning.stop();
  await identity.stop();
  await emails.stop();
  await notifier.close();
  await Promise.all([postgres.stop(), nats.stop(), valkey.stop()]);
});

describe('multi-surface sessions', () => {
  it('signs in on account, binds support with one redirect, and lists one session', async () => {
    const client = new Browser();
    await signUp(client, 'walker@example.com');

    const health = await client.request(ACCOUNT, '/api/v1/meta/health');
    expect(await health.json()).toMatchObject({
      problems: expect.arrayContaining([
        { code: 'CROSS_SITE_SURFACES', surfaces: ['account', 'support'] },
      ]) as unknown,
    });

    const first = await client.request(SUPPORT, '/api/v1/me');
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toContain(`http://${ACCOUNT}/auth/bind?target=support`);
    expect(client.cookie(SUPPORT, BOUND)).toBe('1');

    const bound = await client.follow(await client.follow(first));
    expect(bound.status).toBe(302);
    expect(bound.headers.get('location')).toBe('/api/v1/me');
    expect(client.cookie(SUPPORT, COOKIE)).toBeTruthy();

    const me = await client.request(SUPPORT, '/api/v1/me', {
      headers: { accept: 'application/json' },
    });
    expect(await me.json()).toMatchObject({ email: 'walker@example.com', account_state: 'active' });

    const sessions = await client.request(SUPPORT, '/api/v1/sessions', {
      headers: { accept: 'application/json' },
    });
    expect(await sessions.json()).toMatchObject({
      items: [{ current: true, auth_method: 'magic_link' }],
      next_cursor: null,
    });

    const logout = await client.request(SUPPORT, '/api/v1/auth/logout', { method: 'POST' });
    expect(logout.status).toBe(204);
    expect(client.cookie(SUPPORT, COOKIE)).toBeUndefined();

    const signedOut = await client.request(ACCOUNT, '/api/v1/me', {
      headers: { accept: 'application/json' },
    });
    expect(signedOut.status).toBe(401);
  });

  it('keeps tokens and user IDs out of the logs', () => {
    assertLogsScrubbed(logs.lines, secrets);
  });
});
