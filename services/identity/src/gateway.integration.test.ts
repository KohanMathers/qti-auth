import { solveAltcha } from '@qtiauth/captcha';
import { type Bus, connectBus, publishCronTick } from '@qtiauth/bus';
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
import { LEGAL_PUBLISH_JOB } from './legal.ts';
import { hashLegalBody } from './legal-documents.ts';
import { softwarePasskey } from './passkey-testing.ts';
import { grantUser } from './roles.ts';
import { definition } from './service.ts';
import { startMockOidc } from './social-testing.ts';
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
let oidc: Awaited<ReturnType<typeof startMockOidc>>;
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
          if (name.endsWith('_flow')) secrets.push(value);
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
  [postgres, nats, valkey, oidc] = await Promise.all([
    startPostgres(),
    startNats(),
    startValkey(),
    startMockOidc({
      sub: 'corp-user-1',
      email: 'sam@example.com',
      email_verified: true,
    }),
  ]);
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
      features: {
        auth: {
          social: {
            generic_oidc: [
              {
                id: 'corp',
                name: 'Corp',
                issuer: oidc.issuer,
                client_id: oidc.clientId,
                client_secret: oidc.clientSecret,
              },
            ],
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
  await Promise.all([postgres.stop(), nats.stop(), valkey.stop(), oidc.stop()]);
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

  it('signs up with a password, confirms the email, and resets it', async () => {
    const client = browser();
    const email = 'password-walker@example.com';
    const register = await client.request(
      '/auth/register',
      form({ email, password: 'long-enough-secret', date_of_birth: '1990-02-03' }),
    );
    expect(register.status).toBe(200);
    expect(await register.text()).toContain('Check your email');
    expect(client.cookie()).toBeNull();

    const verifyLink = await emails.nextLink(email);
    const confirmPage = await client.request(`${verifyLink.pathname}${verifyLink.search}`);
    expect(await confirmPage.text()).toContain('action="verify-email"');
    const verifyToken = verifyLink.searchParams.get('token') ?? '';
    secrets.push(verifyToken);
    const confirmed = await client.request('/auth/verify-email', form({ token: verifyToken }));
    expect(confirmed.status).toBe(200);
    expect(await confirmed.text()).toContain('You’re signed in');
    expect(client.cookie()).not.toBeNull();
    await client.request('/api/v1/auth/logout', { method: 'POST' });

    const login = await client.request(
      '/auth/login',
      form({ email, password: 'long-enough-secret' }),
    );
    expect(login.status).toBe(200);
    expect(client.cookie()).not.toBeNull();

    const forgot = await client.request('/auth/forgot-password', form({ email }));
    expect(await forgot.text()).toContain('Check your email');
    const resetLink = await emails.nextLink(email);
    const resetConfirm = await client.request(`${resetLink.pathname}${resetLink.search}`);
    expect(await resetConfirm.text()).toContain('Continue');
    const token = resetLink.searchParams.get('token') ?? '';
    secrets.push(token);
    const continued = await client.request('/auth/reset-password', form({ token }));
    const resetForm = await continued.text();
    expect(resetForm).toContain('Don’t log me out of other sessions');
    expect(resetForm).not.toContain('checked');
    const saved = await client.request(
      '/auth/reset-password',
      form({ token, password: 'brand-new-secret1' }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain('You’re signed in');
  });

  it('challenges password login through the gateway once the IP is over the threshold', async () => {
    const client = browser();
    const email = 'captcha-walker@example.com';
    const register = await client.request(
      '/auth/register',
      form({ email, password: 'long-enough-secret', date_of_birth: '1990-02-03' }),
    );
    expect(register.status).toBe(200);
    secrets.push((await emails.nextLink(email)).searchParams.get('token') ?? '');

    const now = new Date();
    for (const key of ['127.0.0.1', '::1']) {
      await identity.context.db
        .insertInto('auth_failures')
        .values({ kind: 'ip', key, scope: 'password', failures: 1000, updated_at: now })
        .onConflict((conflict) =>
          conflict.columns(['kind', 'key', 'scope']).doUpdateSet({
            failures: 1000,
            updated_at: now,
          }),
        )
        .execute();
    }
    const blocked = await client.request(
      '/auth/login',
      form({ email, password: 'long-enough-secret' }),
    );
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).toContain('Complete the CAPTCHA to continue.');

    const challenge = await client.request('/api/v1/captcha?action=password_login');
    const body = (await challenge.json()) as {
      required: boolean;
      challenge: {
        algorithm: 'SHA-256';
        challenge: string;
        salt: string;
        signature: string;
        maxnumber: number;
      };
    };
    expect(body.required).toBe(true);
    const login = await client.request(
      '/api/v1/auth/password/login',
      json({
        email,
        password: 'long-enough-secret',
        captcha: solveAltcha(body.challenge),
      }),
    );
    expect(login.status).toBe(200);
    expect(client.cookie()).not.toBeNull();
  });

  it('signs a passkey-only account in at aal2, and refuses recovery-code rotation without step-up', async () => {
    const client = browser();
    await signUpInBrowser(client, 'passkey-walker@example.com');
    const authenticator = await softwarePasskey(ORIGIN);
    const start = await client.request('/api/v1/me/passkeys/register/start', json({}));
    const creation = (await start.json()) as {
      challenge: string;
      options: Parameters<typeof authenticator.register>[0];
    };
    secrets.push(creation.challenge);
    const attested = await authenticator.register(creation.options);
    const registered = await client.request(
      '/api/v1/me/passkeys/register',
      json({ challenge: creation.challenge, name: 'Laptop', response: attested }),
    );
    expect(registered.status).toBe(201);
    await client.request('/api/v1/auth/logout', { method: 'POST' });

    const begin = await client.request('/api/v1/auth/passkey/authenticate/start', json({}));
    const assertion = (await begin.json()) as {
      challenge: string;
      options: Parameters<typeof authenticator.authenticate>[0];
    };
    secrets.push(assertion.challenge);
    const asserted = await authenticator.authenticate(assertion.options);
    const signedIn = await client.request(
      '/api/v1/auth/passkey/authenticate',
      json({ challenge: assertion.challenge, response: asserted }),
    );
    expect(signedIn.status).toBe(200);
    expect(client.cookie()).not.toBeNull();
    const me = await client.request('/api/v1/me');
    expect(await me.json()).toMatchObject({
      email: 'passkey-walker@example.com',
      session: { acr: 'aal2', amr: ['webauthn'] },
    });

    const aal1 = browser();
    await signUpInBrowser(aal1, 'step-up-walker@example.com');
    const refused = await aal1.request('/api/v1/me/recovery-codes', { method: 'POST' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('needs a recent aal2 session to delete the account, and signing in cancels it', async () => {
    const aal1 = browser();
    await signUpInBrowser(aal1, 'delete-aal1@example.com');
    const blocked = await aal1.request('/api/v1/me/deletion', { method: 'POST' });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const client = browser();
    await signUpInBrowser(client, 'delete-aal2@example.com');
    const authenticator = await softwarePasskey(ORIGIN);
    const start = await client.request('/api/v1/me/passkeys/register/start', json({}));
    const creation = (await start.json()) as {
      challenge: string;
      options: Parameters<typeof authenticator.register>[0];
    };
    secrets.push(creation.challenge);
    const attested = await authenticator.register(creation.options);
    expect(
      (
        await client.request(
          '/api/v1/me/passkeys/register',
          json({ challenge: creation.challenge, name: 'Laptop', response: attested }),
        )
      ).status,
    ).toBe(201);
    await client.request('/api/v1/auth/logout', { method: 'POST' });

    const begin = await client.request('/api/v1/auth/passkey/authenticate/start', json({}));
    const assertion = (await begin.json()) as {
      challenge: string;
      options: Parameters<typeof authenticator.authenticate>[0];
    };
    secrets.push(assertion.challenge);
    const asserted = await authenticator.authenticate(assertion.options);
    expect(
      (
        await client.request(
          '/api/v1/auth/passkey/authenticate',
          json({ challenge: assertion.challenge, response: asserted }),
        )
      ).status,
    ).toBe(200);

    const deleted = await client.request('/api/v1/me/deletion', { method: 'POST' });
    expect(deleted.status).toBe(204);
    expect(client.cookie()).toBeNull();
    expect((await client.request('/api/v1/me')).status).toBe(401);

    const token = await openLink(client, 'delete-aal2@example.com');
    const confirm = await client.request('/auth/magic-link', form({ token }));
    expect(confirm.status).toBe(200);
    expect(client.cookie()).not.toBeNull();
    expect(await (await client.request('/api/v1/me')).json()).toMatchObject({
      email: 'delete-aal2@example.com',
      account_state: 'active',
      deletion_requested_at: null,
    });
  });

  it('lets staff without 2FA reach enrolment but not the rest of the product', async () => {
    const client = browser();
    await signUpInBrowser(client, 'staff-walker@example.com');
    const me = (await (await client.request('/api/v1/me')).json()) as { id: string };
    await grantUser(identity.context.db, me.id, ['users.read']);
    await client.request('/api/v1/auth/logout', { method: 'POST' });
    const token = await openLink(client, 'staff-walker@example.com');
    const confirm = await client.request('/auth/magic-link', form({ token }));
    expect(confirm.status).toBe(200);

    expect(await (await client.request('/api/v1/sessions')).json()).toMatchObject({
      code: 'TWO_FACTOR_ENROLMENT_REQUIRED',
    });
    expect((await client.request('/api/v1/me/totp/start', json({}))).status).toBe(200);
  });

  it('does not sign in or link to an existing account that happens to use the provider email', async () => {
    async function completeSocial(client: Browser) {
      const start = await client.request('/api/v1/auth/social/corp/start', json({}));
      expect(start.status).toBe(200);
      const { url } = (await start.json()) as { url: string };
      const authorize = await fetch(url, { redirect: 'manual' });
      const redirected = new URL(authorize.headers.get('location') ?? '');
      secrets.push(redirected.searchParams.get('state') ?? '');
      return client.request(
        '/api/v1/auth/social/complete',
        json({
          provider: 'corp',
          state: redirected.searchParams.get('state'),
          code: redirected.searchParams.get('code'),
        }),
      );
    }

    async function finishSignup(client: Browser, dateOfBirth: string) {
      const completed = await completeSocial(client);
      const body = (await completed.json()) as { status: string; challenge: string };
      expect(body.status).toBe('signup_required');
      secrets.push(body.challenge);
      const created = await client.request(
        '/api/v1/auth/social/signup',
        json({ challenge: body.challenge, date_of_birth: dateOfBirth }),
      );
      expect(created.status).toBe(201);
      expect(client.cookie()).not.toBeNull();
      return (await (await client.request('/api/v1/me')).json()) as { id: string };
    }

    oidc.setUser({
      sub: 'gw-first',
      email: 'shared-gw@example.com',
      email_verified: true,
    });
    const first = await finishSignup(browser(), '1990-01-01');
    oidc.setUser({
      sub: 'gw-second',
      email: 'shared-gw@example.com',
      email_verified: true,
    });
    const second = await finishSignup(browser(), '1991-02-02');
    expect(second.id).not.toBe(first.id);
  });

  it('needs a recent aal2 session to change email', async () => {
    const client = browser();
    await signUpInBrowser(client, 'change-email@example.com');
    const refused = await client.request(
      '/api/v1/me/email',
      json({ email: 'changed-email@example.com' }),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('drops a session to aal0 on a country change and restores it on the next sign-in', async () => {
    const home = browser('GB');
    await signUpInBrowser(home, 'travel@example.com');
    const before = (await (await home.request('/api/v1/me')).json()) as {
      session: { id: string; acr: string };
    };
    expect(before.session.acr).toBe('aal1');

    const away = browser('US');
    away.setCookie(home.cookie());
    const challenged = await away.request('/api/v1/me');
    expect(challenged.status).toBe(403);
    expect(await challenged.json()).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });

    const token = await openLink(away, 'travel@example.com');
    const confirm = await away.request('/auth/magic-link', form({ token }));
    expect(confirm.status).toBe(200);
    expect(away.cookie()).toBe(home.cookie());

    const after = (await (await away.request('/api/v1/me')).json()) as {
      session: { id: string; acr: string };
    };
    expect(after.session).toMatchObject({ id: before.session.id, acr: 'aal1' });
  });

  it('gates non-exempt routes after a material legal version, then lifts the gate on every surface', async () => {
    const client = browser();
    await signUpInBrowser(client, 'legal-gate@example.com');
    expect((await client.request('/api/v1/me/identities')).status).toBe(200);

    const body = 'Updated terms for this test.';
    await identity.context.db
      .insertInto('legal_versions')
      .values({
        id: 'terms',
        version: '2026-10-01',
        effective_at: new Date(),
        material: true,
        summary: 'We added passkeys.',
        body,
        body_hash: hashLegalBody(body),
        published_at: null,
      })
      .execute();
    await publishCronTick(notifier.js, LEGAL_PUBLISH_JOB, new Date());

    await vi.waitFor(async () => {
      const blocked = await client.request('/api/v1/me/identities');
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({ code: 'LEGAL_ACCEPTANCE_REQUIRED' });
    });
    expect((await client.request('/api/v1/me/legal')).status).toBe(200);
    expect((await client.request('/support/api/v1/sessions')).status).toBe(403);

    const accept = await client.request(
      '/api/v1/me/legal/accept',
      json({ documents: [{ id: 'terms', version: '2026-10-01' }] }),
    );
    expect(accept.status).toBe(200);

    await vi.waitFor(async () => {
      expect((await client.request('/api/v1/me/identities')).status).toBe(200);
    });
    expect((await client.request('/support/api/v1/sessions')).status).toBe(200);
  });

  it('refuses to disable a security notification category through the API', async () => {
    const client = browser();
    await signUpInBrowser(client, 'notify-sec@example.com');
    const listed = await client.request('/api/v1/me/notifications');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      categories: expect.arrayContaining([
        expect.objectContaining({ id: 'identity.security', disableable: false, enabled: true }),
        expect.objectContaining({ id: 'support.ticket_updates', disableable: true, enabled: true }),
      ]) as unknown,
    });

    const refused = await client.request('/api/v1/me/notifications', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ categories: [{ id: 'identity.security', enabled: false }] }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'NOTIFICATION_REQUIRED' });

    const optional = await client.request('/api/v1/me/notifications', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ categories: [{ id: 'support.ticket_updates', enabled: false }] }),
    });
    expect(optional.status).toBe(200);
    expect(await optional.json()).toMatchObject({
      categories: expect.arrayContaining([
        expect.objectContaining({ id: 'support.ticket_updates', enabled: false }),
      ]) as unknown,
    });
  });

  it('keeps session tokens and links out of every log', () => {
    assertLogsScrubbed(
      logs.lines,
      secrets.filter((secret) => secret !== ''),
    );
  });
});
