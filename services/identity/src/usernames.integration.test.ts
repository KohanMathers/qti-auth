import { randomUUIDv7 } from 'node:crypto';

import { type Bus, connectBus, rpcRequest } from '@qtiauth/bus';
import { checkOutboxContract } from '@qtiauth/bus/testing';
import { sections } from '@qtiauth/config';
import { IDENTITY_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { captureLogs } from '@qtiauth/observability/testing';
import {
  EXPORT_USER_METHOD,
  hashSessionToken,
  type Identity,
  RESOLVE_SESSION_METHOD,
  RESOLVE_SESSION_SERVICE,
  type RunningService,
  SESSION_TOKEN_HEADER,
  serviceSchema,
  startService,
  type UserExport,
} from '@qtiauth/service-kit';
import {
  generateIdentityKey,
  identityHeaders,
  serveTestIdentityKeys,
} from '@qtiauth/service-kit/testing';
import { natsUrl, startNats, startPostgres, startValkey } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from './database.ts';
import { definition } from './service.ts';
import { identityService } from './start.ts';
import { type CapturedEmails, captureEmails } from './testing.ts';

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

function asUser(user: SignedIn): Partial<Identity> {
  return signedInAs(user.userId, user.sessionId);
}

async function setUsername(user: SignedIn, username: string): Promise<Response> {
  return post('/api/v1/me/username', { username }, asUser(user));
}

async function backdateCurrent(userId: string, at: Date): Promise<void> {
  await identity.context.db
    .updateTable('users')
    .set({ username_updated_at: at })
    .where('id', '=', userId)
    .execute();
  await identity.context.db
    .updateTable('username_history')
    .set({ claimed_at: at })
    .where('user_id', '=', userId)
    .where('released_at', 'is', null)
    .execute();
}

beforeAll(async () => {
  [postgres, nats, valkey] = await Promise.all([startPostgres(), startNats(), startValkey()]);
  const bus = sections.bus.parse({ servers: [natsUrl(nats)] });
  gateway = await connectBus(bus, 'gateway');
  notifier = await connectBus(bus, 'notifier');
  serveTestIdentityKeys(gateway, key);
  emails = await captureEmails(notifier);
  identity = await startService(definition, {
    ...identityService({ statsInterval: 60_000 }),
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
      usernames: {
        reserved: ['administrator'],
        reserved_prefixes: ['staff_'],
        change_cooldown: '1h',
        changes_per_year: 10,
        release_hold: '1h',
      },
    }),
  });
});

afterAll(async () => {
  await identity.stop();
  await emails.stop();
  await Promise.all([gateway.close(), notifier.close()]);
  await Promise.all([postgres.stop(), nats.stop(), valkey.stop()]);
});

describe('usernames', () => {
  it('lets an account exist without one, then claim it', async () => {
    const user = await signUp('claim@example.com');
    const before = await call('/api/v1/me', { as: asUser(user) });
    expect(await before.json()).toMatchObject({ username: null, username_updated_at: null });

    const claimed = await setUsername(user, 'AliceUsr');
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ username: 'AliceUsr' });
    expect(await (await setUsername(user, 'aliceusr')).json()).toMatchObject({
      code: 'USERNAME_UNCHANGED',
    });

    const me = await call('/api/v1/me', { as: asUser(user) });
    expect(await me.json()).toMatchObject({ username: 'AliceUsr' });
  });

  it('answers Username not available for taken, reserved, prefixed and filtered names', async () => {
    const owner = await signUp('owner@example.com');
    expect((await setUsername(owner, 'cooluser1')).status).toBe(200);

    const other = await signUp('other@example.com');
    expect(await (await setUsername(other, 'CoolUser1')).json()).toMatchObject({
      code: 'USERNAME_UNAVAILABLE',
      title: 'Username not available',
    });
    expect(await (await setUsername(other, 'administrator')).json()).toMatchObject({
      code: 'USERNAME_UNAVAILABLE',
    });
    expect(await (await setUsername(other, 'staff_ok1')).json()).toMatchObject({
      code: 'USERNAME_UNAVAILABLE',
    });
    expect(await (await setUsername(other, 'CuntUser1')).json()).toMatchObject({
      code: 'USERNAME_UNAVAILABLE',
    });
    expect((await setUsername(other, 'assassin')).status).toBe(200);
  });

  it('rejects names that break the length and character rules', async () => {
    const user = await signUp('rules@example.com');
    expect(await (await setUsername(user, 'short')).json()).toMatchObject({
      code: 'USERNAME_INVALID',
    });
    expect(await (await setUsername(user, 'bad-name!')).json()).toMatchObject({
      code: 'USERNAME_INVALID',
    });
  });

  it('lets the previous owner reclaim during the hold, and nobody else', async () => {
    const owner = await signUp('hold@example.com');
    expect((await setUsername(owner, 'holdname')).status).toBe(200);
    expect(await (await setUsername(owner, 'new_name1')).json()).toMatchObject({
      code: 'USERNAME_COOLDOWN',
    });

    await backdateCurrent(owner.userId, new Date(Date.now() - 2 * 3_600_000));
    expect((await setUsername(owner, 'new_name1')).status).toBe(200);

    const other = await signUp('hold-other@example.com');
    expect(await (await setUsername(other, 'holdname')).json()).toMatchObject({
      code: 'USERNAME_UNAVAILABLE',
    });

    await backdateCurrent(owner.userId, new Date(Date.now() - 2 * 3_600_000));
    expect((await setUsername(owner, 'holdname')).status).toBe(200);

    await backdateCurrent(owner.userId, new Date(Date.now() - 2 * 3_600_000));
    expect((await setUsername(owner, 'new_name1')).status).toBe(200);
    await identity.context.db
      .updateTable('username_history')
      .set({ released_at: new Date(Date.now() - 2 * 3_600_000) })
      .where('canonical', '=', 'holdname')
      .where('released_at', 'is not', null)
      .execute();
    expect((await setUsername(other, 'holdname')).status).toBe(200);
  });

  it('caps how many times a username can change in the window', async () => {
    const user = await signUp('limit@example.com');
    expect((await setUsername(user, 'limitusr')).status).toBe(200);
    const firstAt = new Date(Date.now() - 3 * 3_600_000);
    await identity.context.db
      .updateTable('username_history')
      .set({ claimed_at: firstAt })
      .where('user_id', '=', user.userId)
      .execute();
    await identity.context.db
      .updateTable('users')
      .set({ username_updated_at: firstAt })
      .where('id', '=', user.userId)
      .execute();
    await identity.context.db
      .insertInto('username_history')
      .values(
        Array.from({ length: 10 }, (_, i) => ({
          id: randomUUIDv7(),
          user_id: user.userId,
          username: `oldname${String(i).padStart(2, '0')}`,
          canonical: `oldname${String(i).padStart(2, '0')}`,
          claimed_at: new Date(Date.now() - 3_600_000),
          released_at: new Date(Date.now() - 3_600_000),
        })),
      )
      .execute();
    expect(await (await setUsername(user, 'limitus2')).json()).toMatchObject({
      code: 'USERNAME_CHANGE_LIMIT',
    });
  });

  it('rejects a password that contains the username', async () => {
    const user = await signUp('pwd-user@example.com');
    expect((await setUsername(user, 'pwduser1')).status).toBe(200);
    const added = await post('/api/v1/me/password', { password: 'pwduser1-secret' }, asUser(user));
    expect(await added.json()).toMatchObject({ code: 'PASSWORD_REJECTED' });
  });

  it('exports username history and writes user.updated', async () => {
    const user = await signUp('export-user@example.com');
    expect((await setUsername(user, 'exportusr')).status).toBe(200);
    const exported = await rpcRequest<UserExport>(gateway, 'identity', EXPORT_USER_METHOD, {
      user_id: user.userId,
    });
    expect(exported).toMatchObject({
      status: 'ok',
      data: {
        data: {
          account: { username: 'exportusr' },
          username_history: [{ username: 'exportusr', released_at: null }],
        },
      },
    });

    const events = await checkOutboxContract(identity.context.db, await loadEventCatalog());
    expect(events.map((event) => event.type)).toContain(IDENTITY_EVENTS.userUpdated);
  });
});
