import { randomUUIDv7 } from 'node:crypto';

import { type Bus, connectBus, publishCronTick, rpcRequest, serveRpc } from '@qtiauth/bus';
import { checkOutboxContract } from '@qtiauth/bus/testing';
import { sections } from '@qtiauth/config';
import { IDENTITY_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { UNLOCK_JOB } from './account-locks.ts';
import {
  USER_ENTITLEMENTS_METHOD,
  USER_MODERATION_METHOD,
  USER_TICKETS_METHOD,
} from './admin-users.ts';
import type { Database } from './database.ts';
import { definition } from './service.ts';
import { identityService } from './start.ts';
import { type CapturedEmails, captureEmails } from './testing.ts';
import { hashToken } from './tokens.ts';

const HOST = 'me.example.com';
const key = generateIdentityKey();
const STAFF_PERMISSIONS = [
  'users.read',
  'users.ban',
  'users.lock',
  'users.force_username_reset',
] as const;

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
  const result = await rpcRequest<{
    session: { session_id: string; account_state: string; acr: string } | null;
  }>(gateway, RESOLVE_SESSION_SERVICE, RESOLVE_SESSION_METHOD, {
    binding_token_hash: hashSessionToken(token),
    cookie_scope: HOST,
  });
  if (result.status !== 'ok') throw new Error(`resolve_session failed: ${result.status}`);
  return result.data.session;
}

async function signUp(email: string, dateOfBirth = '1990-05-01'): Promise<SignedIn> {
  const verify = await post('/api/v1/auth/magic-link/verify', { token: await linkToken(email) });
  const next = (await verify.json()) as { status: string; signup_token: string };
  expect(next.status).toBe('signup_required');
  secrets.push(next.signup_token);
  const signup = await post('/api/v1/auth/magic-link/signup', {
    signup_token: next.signup_token,
    date_of_birth: dateOfBirth,
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

function asStaff(user: SignedIn): Partial<Identity> {
  return {
    ...signedInAs(user.userId, user.sessionId),
    acr: 'aal2',
    permissions: [...STAFF_PERMISSIONS],
  };
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

describe('admin users', () => {
  it('searches, filters by state, and assembles detail without optional services', async () => {
    const staff = await signUp('admin-staff@example.com');
    const target = await signUp('search-target@example.com');
    expect(
      (await post('/api/v1/me/username', { username: 'SearchUsr' }, asUser(target))).status,
    ).toBe(200);

    const listed = await call('/api/v1/admin/users?q=SearchUsr', { as: asStaff(staff) });
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as {
      items: { id: string; email: string; username: string }[];
    };
    expect(page.items.some((item) => item.id === target.userId)).toBe(true);
    expect(page.items.find((item) => item.id === target.userId)).toMatchObject({
      email: 'search-target@example.com',
      username: 'SearchUsr',
      state: 'active',
    });

    const active = await call('/api/v1/admin/users?state=active', { as: asStaff(staff) });
    expect(
      ((await active.json()) as { items: { id: string }[] }).items.some(
        (item) => item.id === target.userId,
      ),
    ).toBe(true);

    const missing = await call(`/api/v1/admin/users/${randomUUIDv7()}`, { as: asStaff(staff) });
    expect(await missing.json()).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });

    const detail = await call(`/api/v1/admin/users/${target.userId}`, { as: asStaff(staff) });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      profile: { id: string; email: string; state: string };
      sign_in_methods: { type: string }[];
      sessions: { id: string }[];
      security_events: unknown[];
      username_history: { username: string }[];
      guardians: unknown[];
      moderation?: unknown;
      entitlements?: unknown;
      tickets?: unknown;
    };
    expect(body.profile).toMatchObject({
      id: target.userId,
      email: 'search-target@example.com',
      state: 'active',
      username_reset_required: false,
    });
    expect(body.sign_in_methods.some((method) => method.type === 'magic_link')).toBe(true);
    expect(body.sessions.some((session) => session.id === target.sessionId)).toBe(true);
    expect(body.username_history[0]).toMatchObject({ username: 'SearchUsr' });
    expect(body.guardians).toEqual([]);
    expect(body).not.toHaveProperty('moderation');
    expect(body).not.toHaveProperty('entitlements');
    expect(body).not.toHaveProperty('tickets');
  });

  it('omits optional sections until those services answer, then includes them', async () => {
    const staff = await signUp('admin-rpc-staff@example.com');
    const target = await signUp('admin-rpc-user@example.com');
    const bus = sections.bus.parse({ servers: [natsUrl(nats)] });
    const safety = await connectBus(bus, 'safety');
    const games = await connectBus(bus, 'games');
    const support = await connectBus(bus, 'support');
    const servers = [
      serveRpc<{ user_id: string }, { items: { id: string }[] }>(safety, {
        method: USER_MODERATION_METHOD,
        handler: (request) => Promise.resolve({ items: [{ id: `mod-${request.user_id}` }] }),
        onError: () => undefined,
      }),
      serveRpc<{ user_id: string }, { items: { id: string }[] }>(games, {
        method: USER_ENTITLEMENTS_METHOD,
        handler: (request) => Promise.resolve({ items: [{ id: `ent-${request.user_id}` }] }),
        onError: () => undefined,
      }),
      serveRpc<{ user_id: string }, { items: { id: string }[] }>(support, {
        method: USER_TICKETS_METHOD,
        handler: (request) => Promise.resolve({ items: [{ id: `tkt-${request.user_id}` }] }),
        onError: () => undefined,
      }),
    ];
    try {
      const detail = await call(`/api/v1/admin/users/${target.userId}`, { as: asStaff(staff) });
      expect(await detail.json()).toMatchObject({
        moderation: { items: [{ id: `mod-${target.userId}` }] },
        entitlements: { items: [{ id: `ent-${target.userId}` }] },
        tickets: { items: [{ id: `tkt-${target.userId}` }] },
      });
    } finally {
      await Promise.all(servers.map((server) => server.stop()));
      await Promise.all([safety.close(), games.close(), support.close()]);
    }
  });

  it('bans, unbans, locks with expiry, unlocks, forces re-auth, revokes sessions and resets usernames', async () => {
    const staff = await signUp('admin-actions-staff@example.com');
    const target = await signUp('admin-actions-user@example.com');
    expect(
      (await post('/api/v1/me/username', { username: 'ActionUsr' }, asUser(target))).status,
    ).toBe(200);
    const staffAs = asStaff(staff);
    const path = `/api/v1/admin/users/${target.userId}`;

    expect((await post(`${path}/ban`, { reason: 'Nope' }, asUser(staff))).status).toBe(403);
    expect(
      await (await post(`${path}/ban`, { reason: 'Self' }, asStaff(target))).json(),
    ).toMatchObject({ code: 'ACCOUNT_SELF' });

    expect((await post(`${path}/ban`, { reason: 'Repeated abuse' }, staffAs)).status).toBe(204);
    expect(await resolve(target.token)).toMatchObject({ account_state: 'banned' });
    expect((await call('/api/v1/me', { as: asUser(target) })).status).toBe(200);
    expect((await post(`${path}/ban`, { reason: 'Again' }, staffAs)).status).toBe(409);

    const events = await checkOutboxContract(identity.context.db, await loadEventCatalog());
    expect(events).toContainEqual(
      expect.objectContaining({
        type: IDENTITY_EVENTS.userBanned,
        subject: { type: 'user', id: target.userId },
        data: { reason: 'Repeated abuse' },
      }),
    );

    expect((await post(`${path}/unban`, { reason: 'Appeal upheld' }, staffAs)).status).toBe(204);
    expect(await resolve(target.token)).toMatchObject({ account_state: 'active' });

    expect(
      await (
        await post(
          `${path}/lock`,
          { reason: 'Past', expires_at: new Date(Date.now() - 1000).toISOString() },
          staffAs,
        )
      ).json(),
    ).toMatchObject({ code: 'LOCK_EXPIRY_INVALID' });

    const expiresAt = new Date(Date.now() + 200).toISOString();
    expect(
      (await post(`${path}/lock`, { reason: 'Investigation', expires_at: expiresAt }, staffAs))
        .status,
    ).toBe(204);
    await vi.waitFor(async () => {
      await publishCronTick(gateway.js, UNLOCK_JOB, new Date());
      const unlocked = await call(path, { as: staffAs });
      expect(await unlocked.json()).toMatchObject({ profile: { state: 'active' } });
    });
    expect(await resolve(target.token)).toMatchObject({ account_state: 'active' });

    const later = new Date(Date.now() + 60_000).toISOString();
    expect(
      (await post(`${path}/lock`, { reason: 'Hold', expires_at: later }, staffAs)).status,
    ).toBe(204);
    expect(await resolve(target.token)).toMatchObject({ account_state: 'locked' });
    expect((await post(`${path}/unlock`, { reason: 'Cleared' }, staffAs)).status).toBe(204);
    expect(await resolve(target.token)).toMatchObject({ account_state: 'active' });

    const reauth = await post(`${path}/reauth`, { reason: 'Suspicious activity' }, staffAs);
    expect(reauth.status).toBe(200);
    expect(await reauth.json()).toMatchObject({ challenged: 1 });
    expect(await resolve(target.token)).toMatchObject({ acr: 'aal0' });

    const revoke = await post(`${path}/sessions/revoke`, { reason: 'End sessions' }, staffAs);
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({ revoked: 1 });
    expect(await resolve(target.token)).toBeNull();

    const reset = await post(`${path}/username-reset`, { reason: 'Impersonation' }, staffAs);
    expect(reset.status).toBe(204);
    const me = await call('/api/v1/me', { as: asUser(target) });
    expect(await me.json()).toMatchObject({
      username: null,
      username_reset_required: true,
    });
    expect(
      (await post('/api/v1/me/username', { username: 'ActionNew' }, asUser(target))).status,
    ).toBe(200);
    expect(await (await call('/api/v1/me', { as: asUser(target) })).json()).toMatchObject({
      username: 'ActionNew',
      username_reset_required: false,
    });

    const exported = await rpcRequest<UserExport>(gateway, 'identity', EXPORT_USER_METHOD, {
      user_id: target.userId,
    });
    expect(exported).toMatchObject({
      status: 'ok',
      data: {
        data: {
          account: { username_reset_required: false },
          staff_actions: expect.arrayContaining([
            expect.objectContaining({ action: 'ban', reason: 'Repeated abuse' }),
            expect.objectContaining({ action: 'force_username_reset' }),
          ]) as unknown,
        },
      },
    });
  });

  it('keeps tokens and addresses out of the logs', () => {
    expect(logs.lines.length).toBeGreaterThan(0);
    assertLogsScrubbed(logs.lines, [
      ...secrets,
      ...secrets.map((secret) => hashToken(secret)),
      'admin-staff@example.com',
      'search-target@example.com',
      'admin-rpc-staff@example.com',
      'admin-rpc-user@example.com',
      'admin-actions-staff@example.com',
      'admin-actions-user@example.com',
      postgres.getPassword(),
    ]);
  });
});
