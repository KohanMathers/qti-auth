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

const ORIGIN = 'http://localhost:8000';
const COOKIE = '__Host-qtiauth_session';
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
let identity: RunningService<typeof definition, Database>;
let gatewayRunning: RunningService<typeof gatewayDefinition>;
let gateway: RunningGateway;
const logs = captureLogs();
const secrets: string[] = [];

interface Browser {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  cookie: () => string | null;
  setCookie: (value: string | null) => void;
}

function browser(): Browser {
  let cookie: string | null = null;
  return {
    cookie: () => cookie,
    setCookie: (value) => {
      cookie = value;
    },
    request: async (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (init.method !== undefined && init.method !== 'GET') headers.set('origin', ORIGIN);
      if (cookie !== null) headers.set('cookie', cookie);
      const response = await fetch(`http://localhost:${String(gateway.ports[0])}${path}`, {
        ...init,
        headers,
        redirect: 'manual',
      });
      const set = response.headers.get('set-cookie');
      if (set?.startsWith(`${COOKIE}=`)) {
        const pair = set.split(';')[0] ?? '';
        cookie = pair.endsWith('=') ? null : pair;
        if (cookie !== null) secrets.push(pair.slice(COOKIE.length + 1));
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

async function signUpInBrowser(client: Browser, email: string): Promise<void> {
  const token = await openLink(client, email);
  const confirm = await client.request('/auth/magic-link', form({ token }));
  const dobPage = await confirm.text();
  const signupToken = /name="signup_token" value="([^"]+)"/.exec(dobPage)?.[1] ?? '';
  expect(signupToken).not.toBe('');
  secrets.push(signupToken);
  const created = await client.request(
    '/auth/signup',
    form({ signup_token: signupToken, date_of_birth: '1990-02-03' }),
  );
  expect(created.status).toBe(200);
  expect(await created.text()).toContain('You’re signed in');
  expect(client.cookie()).not.toBeNull();
}

beforeAll(async () => {
  [postgres, nats, valkey] = await Promise.all([startPostgres(), startNats(), startValkey()]);
  const observability = {
    logs: { user_id_hash_key: 'integration' },
    metrics: { process_metrics: false },
  };
  notifier = await connectBus(sections.bus.parse({ servers: [natsUrl(nats)] }), 'notifier');
  emails = await captureEmails(notifier);

  identity = await startService(definition, {
    ...identityService(),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    config: serviceSchema(definition).parse({
      bus: { servers: [natsUrl(nats)] },
      database: {
        host: postgres.getHost(),
        port: postgres.getPort(),
        name: postgres.getDatabase(),
        roles: { identity: { user: postgres.getUsername(), password: postgres.getPassword() } },
      },
      observability,
      surfaces,
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

describe('identity through the gateway', () => {
  it('signs up a new user by magic link, shows their session and signs them out', async () => {
    const client = browser();
    await signUpInBrowser(client, 'walker@example.com');

    const sessions = await client.request('/api/v1/sessions');
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toMatchObject({
      items: [{ current: true, auth_method: 'magic_link' }],
      next_cursor: null,
    });
    const me = await client.request('/support/api/v1/me');
    expect(await me.json()).toMatchObject({ email: 'walker@example.com', account_state: 'active' });

    const signedOutCookie = client.cookie();
    const logout = await client.request('/api/v1/auth/logout', { method: 'POST' });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain(`${COOKIE}=; Path=/; Max-Age=0`);
    expect(logout.headers.has('x-qtiauth-session-clear')).toBe(false);
    expect(client.cookie()).toBeNull();

    client.setCookie(signedOutCookie);
    expect((await client.request('/api/v1/me')).status).toBe(401);
  });

  it('answers magic-link starts identically for existing and unknown addresses', async () => {
    const client = browser();
    const existing = await client.request(
      '/api/v1/auth/magic-link/start',
      json({ email: 'walker@example.com' }),
    );
    const unknown = await client.request(
      '/api/v1/auth/magic-link/start',
      json({ email: 'stranger@example.com' }),
    );
    expect(existing.status).toBe(202);
    expect(unknown.status).toBe(existing.status);
    expect(Buffer.from(await unknown.arrayBuffer())).toEqual(
      Buffer.from(await existing.arrayBuffer()),
    );
    secrets.push(
      (await emails.nextLink('walker@example.com')).searchParams.get('token') ?? '',
      (await emails.nextLink('stranger@example.com')).searchParams.get('token') ?? '',
    );
  });

  it('makes a revoked session stop working on the very next request', async () => {
    const laptop = browser();
    await signUpInBrowser(laptop, 'two-devices@example.com');
    const phone = browser();
    const token = await openLink(phone, 'two-devices@example.com');
    const confirm = await phone.request('/auth/magic-link', form({ token }));
    expect(confirm.status).toBe(200);
    expect(phone.cookie()).not.toBeNull();

    expect((await phone.request('/api/v1/me')).status).toBe(200);
    const listed = (await (await laptop.request('/api/v1/sessions')).json()) as {
      items: { id: string; current: boolean }[];
    };
    const phoneSession = listed.items.find((item) => !item.current);
    expect(listed.items).toHaveLength(2);

    const revoke = await laptop.request(`/api/v1/sessions/${phoneSession?.id ?? ''}`, {
      method: 'DELETE',
    });
    expect(revoke.status).toBe(204);
    expect(laptop.cookie()).not.toBeNull();

    const after = await phone.request('/api/v1/me');
    expect(after.status).toBe(401);
    expect((await laptop.request('/api/v1/me')).status).toBe(200);
  });

  it('keeps session tokens and links out of every log', () => {
    assertLogsScrubbed(
      logs.lines,
      secrets.filter((secret) => secret !== ''),
    );
  });
});
