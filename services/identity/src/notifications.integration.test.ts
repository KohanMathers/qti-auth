import { type Bus, connectBus, createEvent, publishEvent, rpcRequest } from '@qtiauth/bus';
import { checkOutboxContract } from '@qtiauth/bus/testing';
import { sections } from '@qtiauth/config';
import { IDENTITY_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { captureLogs } from '@qtiauth/observability/testing';
import {
  EXPORT_USER_METHOD,
  hashSessionToken,
  type Identity,
  NOTIFICATION_ALLOWED_METHOD,
  NOTIFICATION_ALLOWED_SERVICE,
  RESOLVE_SESSION_METHOD,
  RESOLVE_SESSION_SERVICE,
  type RunningService,
  SESSION_TOKEN_HEADER,
  serviceSchema,
  STAFF_ALERT_RECIPIENTS_METHOD,
  STAFF_ALERT_RECIPIENTS_SERVICE,
  startService,
  USER_DELETED_EVENT,
  type UserExport,
} from '@qtiauth/service-kit';
import {
  generateIdentityKey,
  identityHeaders,
  serveTestIdentityKeys,
} from '@qtiauth/service-kit/testing';
import { natsUrl, startNats, startPostgres, startValkey } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Database } from './database.ts';
import { definition } from './service.ts';
import { identityService } from './start.ts';
import { type CapturedEmails, captureEmails, grantUser } from './testing.ts';

const HOST = 'me.example.com';
const key = generateIdentityKey();

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let valkey: Awaited<ReturnType<typeof startValkey>>;
let gateway: Bus;
let notifier: Bus;
let emails: CapturedEmails;
let identity: RunningService<typeof definition, Database>;
const logs = captureLogs();
const secrets: string[] = [];

const anonymous: Partial<Identity> = {
  auth: 'none',
  sub: null,
  sid: null,
  account_state: null,
  age_band: null,
  amr: [],
  acr: null,
};

function call(path: string, init: RequestInit & { as?: Partial<Identity> } = {}) {
  const { as = anonymous, ...rest } = init;
  return fetch(`${identity.url}${path}`, {
    ...rest,
    headers: {
      ...identityHeaders(key, 'identity', as),
      'x-forwarded-host': HOST,
      'user-agent': 'Integration/1.0',
      ...(rest.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

function post(path: string, body?: unknown, as?: Partial<Identity>) {
  return call(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(as === undefined ? {} : { as }),
  });
}

function patch(path: string, body: unknown, as?: Partial<Identity>) {
  return call(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
    ...(as === undefined ? {} : { as }),
  });
}

function signedInAs(userId: string, sessionId: string): Partial<Identity> {
  return { auth: 'session', sub: userId, sid: sessionId, amr: ['email'], acr: 'aal1' };
}

async function linkToken(email: string): Promise<string> {
  const start = await post('/api/v1/auth/magic-link/start', { email });
  expect(start.status).toBe(202);
  const token = (await emails.nextLink(email)).searchParams.get('token') ?? '';
  secrets.push(token);
  return token;
}

interface SignedIn {
  userId: string;
  token: string;
  sessionId: string;
}

async function resolve(token: string) {
  const result = await rpcRequest<{ session: { session_id: string } | null }>(
    gateway,
    RESOLVE_SESSION_SERVICE,
    RESOLVE_SESSION_METHOD,
    { binding_token_hash: hashSessionToken(token), cookie_scope: HOST },
  );
  if (result.status !== 'ok') throw new Error(`resolve_session failed: ${result.status}`);
  return result.data.session;
}

async function signUp(email: string): Promise<SignedIn> {
  const verify = await post('/api/v1/auth/magic-link/verify', { token: await linkToken(email) });
  const next = (await verify.json()) as { status: string; signup_token: string };
  expect(next.status).toBe('signup_required');
  secrets.push(next.signup_token);
  const signup = await post('/api/v1/auth/magic-link/signup', {
    signup_token: next.signup_token,
    date_of_birth: '1990-05-01',
  });
  expect(signup.status).toBe(201);
  const body = (await signup.json()) as { user_id: string };
  const token = signup.headers.get(SESSION_TOKEN_HEADER) ?? '';
  secrets.push(token);
  const session = await resolve(token);
  return { userId: body.user_id, token, sessionId: session?.session_id ?? '' };
}

function asUser(user: SignedIn, extra: Partial<Identity> = {}): Partial<Identity> {
  return { ...signedInAs(user.userId, user.sessionId), ...extra };
}

async function allowed(userId: string, category: string): Promise<boolean> {
  const result = await rpcRequest<{ allowed: boolean }>(
    gateway,
    NOTIFICATION_ALLOWED_SERVICE,
    NOTIFICATION_ALLOWED_METHOD,
    { user_id: userId, category },
  );
  if (result.status !== 'ok') throw new Error(`notification_allowed failed: ${result.status}`);
  return result.data.allowed;
}

beforeAll(async () => {
  [postgres, nats, valkey] = await Promise.all([startPostgres(), startNats(), startValkey()]);
  const bus = sections.bus.parse({ servers: [natsUrl(nats)] });
  gateway = await connectBus(bus, 'gateway');
  notifier = await connectBus(bus, 'notifier');
  serveTestIdentityKeys(gateway, key);
  emails = await captureEmails(notifier);
  identity = await startService(definition, {
    ...identityService({ statsInterval: 200 }),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    config: serviceSchema(definition).parse({
      bus: { servers: [natsUrl(nats)] },
      captcha: { after: 1000 },
      database: {
        host: postgres.getHost(),
        port: postgres.getPort(),
        name: postgres.getDatabase(),
        roles: { identity: { user: postgres.getUsername(), password: postgres.getPassword() } },
      },
      observability: {
        logs: { user_id_hash_key: 'integration' },
        metrics: { process_metrics: false },
      },
      surfaces: { account: { hosts: [HOST] } },
      valkey: { host: valkey.getHost(), port: valkey.getPort() },
      password: {
        argon2: { memory_kib: 8, iterations: 1 },
        breach_check: false,
      },
      security: { encryption_key: Buffer.alloc(32, 9).toString('base64') },
    }),
  });
});

afterAll(async () => {
  await identity.stop();
  await emails.stop();
  await Promise.all([gateway.close(), notifier.close()]);
  await Promise.all([postgres.stop(), nats.stop(), valkey.stop()]);
});

describe('notification preferences', () => {
  it('lists user categories on, refuses to disable security, and honours optional toggles', async () => {
    const user = await signUp('prefs@example.com');
    const listed = await call('/api/v1/me/notifications', { as: asUser(user) });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      categories: {
        id: string;
        disableable: boolean;
        enabled: boolean;
        audience: string;
      }[];
    };
    expect(body.categories.map((category) => category.id)).toEqual([
      'identity.legal',
      'identity.security',
      'support.ticket_updates',
    ]);
    expect(body.categories.find((category) => category.id === 'identity.security')).toMatchObject({
      disableable: false,
      enabled: true,
      audience: 'user',
    });
    expect(
      body.categories.find((category) => category.id === 'support.ticket_updates'),
    ).toMatchObject({ disableable: true, enabled: true });

    const refused = await patch(
      '/api/v1/me/notifications',
      { categories: [{ id: 'identity.security', enabled: false }] },
      asUser(user),
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'NOTIFICATION_REQUIRED' });
    expect(await allowed(user.userId, 'identity.security')).toBe(true);

    const updated = await patch(
      '/api/v1/me/notifications',
      { categories: [{ id: 'support.ticket_updates', enabled: false }] },
      asUser(user),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      categories: expect.arrayContaining([
        expect.objectContaining({ id: 'support.ticket_updates', enabled: false }),
        expect.objectContaining({ id: 'identity.security', enabled: true }),
      ]) as unknown,
    });
    expect(await allowed(user.userId, 'support.ticket_updates')).toBe(false);
    expect(await allowed(user.userId, 'identity.legal')).toBe(true);

    await vi.waitFor(async () => {
      const events = await checkOutboxContract(identity.context.db, await loadEventCatalog());
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: IDENTITY_EVENTS.userUpdated,
            data: { fields: ['notifications'] },
          }),
        ]),
      );
    });

    const exported = await rpcRequest<UserExport>(gateway, 'identity', EXPORT_USER_METHOD, {
      user_id: user.userId,
    });
    expect(exported).toMatchObject({
      status: 'ok',
      data: {
        data: {
          notification_preferences: [{ category: 'support.ticket_updates', enabled: false }],
        },
      },
    });
  });

  it('hides staff alert categories from ordinary users', async () => {
    const user = await signUp('prefs-user@example.com');
    const listed = await call('/api/v1/me/notifications', { as: asUser(user) });
    const ids = ((await listed.json()) as { categories: { id: string }[] }).categories.map(
      (category) => category.id,
    );
    expect(ids).not.toContain('support.new_tickets');
    expect(ids).not.toContain('safety.high_priority_reports');

    expect(
      await (
        await patch(
          '/api/v1/me/notifications',
          { categories: [{ id: 'support.new_tickets', enabled: false }] },
          asUser(user),
        )
      ).json(),
    ).toMatchObject({ code: 'NOTIFICATION_CATEGORY_NOT_FOUND' });
    expect(
      await (
        await patch(
          '/api/v1/me/notifications',
          { categories: [{ id: 'no.such.category', enabled: false }] },
          asUser(user),
        )
      ).json(),
    ).toMatchObject({ code: 'NOTIFICATION_CATEGORY_NOT_FOUND' });
  });

  it('lets staff toggle alert preferences', async () => {
    const user = await signUp('prefs-staff@example.com');
    const staff = asUser(user, { permissions: ['users.read'] });
    const listed = await call('/api/v1/me/notifications', { as: staff });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      categories: expect.arrayContaining([
        expect.objectContaining({
          id: 'support.new_tickets',
          audience: 'staff',
          disableable: true,
          enabled: true,
        }),
        expect.objectContaining({ id: 'safety.high_priority_reports', audience: 'staff' }),
      ]) as unknown,
    });

    const updated = await patch(
      '/api/v1/me/notifications',
      { categories: [{ id: 'support.new_tickets', enabled: false }] },
      staff,
    );
    expect(updated.status).toBe(200);
    expect(await allowed(user.userId, 'support.new_tickets')).toBe(false);
  });

  it('lists staff who have a staff alert category enabled', async () => {
    const user = await signUp('prefs-staff-recipients@example.com');
    const empty = await rpcRequest<{ recipients: { user_id: string }[] }>(
      gateway,
      STAFF_ALERT_RECIPIENTS_SERVICE,
      STAFF_ALERT_RECIPIENTS_METHOD,
      { category: 'support.new_tickets' },
    );
    expect(empty.status).toBe('ok');
    if (empty.status === 'ok') {
      expect(empty.data.recipients.some((row) => row.user_id === user.userId)).toBe(false);
    }

    await grantUser(identity.context.db, user.userId, ['users.read']);
    const listed = await rpcRequest<{ recipients: { user_id: string; email: string }[] }>(
      gateway,
      STAFF_ALERT_RECIPIENTS_SERVICE,
      STAFF_ALERT_RECIPIENTS_METHOD,
      { category: 'support.new_tickets' },
    );
    expect(listed.status).toBe('ok');
    if (listed.status === 'ok') {
      expect(listed.data.recipients.some((row) => row.user_id === user.userId)).toBe(true);
    }

    expect(
      (
        await patch(
          '/api/v1/me/notifications',
          { categories: [{ id: 'support.new_tickets', enabled: false }] },
          asUser(user, { permissions: ['users.read'] }),
        )
      ).status,
    ).toBe(200);
    const optedOut = await rpcRequest<{ recipients: { user_id: string }[] }>(
      gateway,
      STAFF_ALERT_RECIPIENTS_SERVICE,
      STAFF_ALERT_RECIPIENTS_METHOD,
      { category: 'support.new_tickets' },
    );
    expect(optedOut.status).toBe('ok');
    if (optedOut.status === 'ok') {
      expect(optedOut.data.recipients.some((row) => row.user_id === user.userId)).toBe(false);
    }
  });

  it('erases stored preferences with the account', async () => {
    const user = await signUp('prefs-erase@example.com');
    expect(
      (
        await patch(
          '/api/v1/me/notifications',
          { categories: [{ id: 'support.ticket_updates', enabled: false }] },
          asUser(user),
        )
      ).status,
    ).toBe(200);
    await publishEvent(
      gateway.js,
      createEvent({
        type: USER_DELETED_EVENT,
        actor: { type: 'system', id: 'identity' },
        subject: { type: 'user', id: user.userId },
        data: { held: false },
      }),
    );
    await vi.waitFor(async () => {
      const rows = await identity.context.db
        .selectFrom('notification_preferences')
        .select('category')
        .where('user_id', '=', user.userId)
        .execute();
      expect(rows).toEqual([]);
    });
  });
});
