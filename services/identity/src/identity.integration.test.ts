import { randomUUIDv7 } from 'node:crypto';

import {
  type Bus,
  connectBus,
  createEvent,
  publishCronTick,
  publishEvent,
  rpcRequest,
} from '@qtiauth/bus';
import { checkOutboxContract } from '@qtiauth/bus/testing';
import { sections } from '@qtiauth/config';
import { loadEventCatalog } from '@qtiauth/events';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import {
  EXPORT_USER_METHOD,
  type Identity,
  REVOKED_SESSIONS_HEADER,
  type RunningService,
  SESSION_CLEAR_HEADER,
  SESSION_EXPIRES_HEADER,
  SESSION_TOKEN_HEADER,
  serviceSchema,
  startService,
  USER_DELETED_EVENT,
  type UserExport,
} from '@qtiauth/service-kit';
import {
  generateIdentityKey,
  identityHeaders,
  serveTestIdentityKeys,
} from '@qtiauth/service-kit/testing';
import { natsUrl, startNats, startPostgres } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Database } from './database.ts';
import { definition } from './service.ts';
import { identityService } from './start.ts';
import { type CapturedEmails, captureEmails } from './testing.ts';
import { hashToken } from './tokens.ts';

const HOST = 'me.example.com';
const key = generateIdentityKey();

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
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
  response: Response;
}

async function resolve(token: string) {
  const result = await rpcRequest<{ session: { session_id: string } | null }>(
    gateway,
    'identity',
    'resolve_session',
    { binding_token_hash: hashToken(token), cookie_scope: HOST },
  );
  if (result.status !== 'ok') throw new Error(`resolve_session failed: ${result.status}`);
  return result.data.session;
}

async function finish(response: Response): Promise<SignedIn> {
  const body = (await response.json()) as { user_id: string };
  const token = response.headers.get(SESSION_TOKEN_HEADER) ?? '';
  secrets.push(token);
  const session = await resolve(token);
  return { userId: body.user_id, token, sessionId: session?.session_id ?? '', response };
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
  return finish(signup);
}

async function signIn(email: string): Promise<SignedIn> {
  const verify = await post('/api/v1/auth/magic-link/verify', { token: await linkToken(email) });
  expect(verify.status).toBe(200);
  return finish(verify);
}

beforeAll(async () => {
  [postgres, nats] = await Promise.all([startPostgres(), startNats()]);
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
      sessions: { max_per_user: 3 },
    }),
  });
});

afterAll(async () => {
  await identity.stop();
  await emails.stop();
  await Promise.all([gateway.close(), notifier.close()]);
  await Promise.all([postgres.stop(), nats.stop()]);
});

describe('magic link start', () => {
  it('answers identically whether or not an account exists, and emails a link either way', async () => {
    await signUp('exists@example.com');
    const existing = await post('/api/v1/auth/magic-link/start', { email: 'exists@example.com' });
    const missing = await post('/api/v1/auth/magic-link/start', { email: 'nobody@example.com' });

    expect(existing.status).toBe(missing.status);
    expect(existing.headers.get('content-type')).toBe(missing.headers.get('content-type'));
    expect(await existing.text()).toBe(await missing.text());

    const link = await emails.nextLink('exists@example.com');
    expect(link.origin).toBe(`https://${HOST}`);
    expect(link.pathname).toBe('/auth/magic-link');
    await emails.nextLink('nobody@example.com');
  });
});

describe('signing up and signing in', () => {
  it('creates an active account after the date of birth, and signs in with a bound session', async () => {
    const signedUp = await signUp('new@example.com', '2011-01-01');
    expect(signedUp.response.headers.get(SESSION_EXPIRES_HEADER)).toBeTruthy();

    const session = await rpcRequest(gateway, 'identity', 'resolve_session', {
      binding_token_hash: hashToken(signedUp.token),
      cookie_scope: HOST,
    });
    expect(session).toMatchObject({
      status: 'ok',
      data: {
        session: {
          user_id: signedUp.userId,
          account_state: 'active',
          age_band: '13_to_15',
          amr: ['email'],
          acr: 'aal1',
          legal_acceptance_required: false,
        },
      },
    });
    const otherHost = await rpcRequest(gateway, 'identity', 'resolve_session', {
      binding_token_hash: hashToken(signedUp.token),
      cookie_scope: 'elsewhere.example.com',
    });
    expect(otherHost).toMatchObject({ status: 'ok', data: { session: null } });

    const me = await call('/api/v1/me', { as: signedInAs(signedUp.userId, signedUp.sessionId) });
    expect(await me.json()).toMatchObject({
      id: signedUp.userId,
      email: 'new@example.com',
      email_verified: true,
      account_state: 'active',
      age_band: '13_to_15',
    });

    const again = await signIn('NEW@example.com');
    expect(again.userId).toBe(signedUp.userId);
    expect(again.sessionId).not.toBe(signedUp.sessionId);
  });

  it('uses each link once and refuses expired ones', async () => {
    const token = await linkToken('once@example.com');
    const first = await post('/api/v1/auth/magic-link/verify', { token });
    expect(await first.json()).toMatchObject({ status: 'signup_required' });
    const reused = await post('/api/v1/auth/magic-link/verify', { token });
    expect(await reused.json()).toMatchObject({ code: 'MAGIC_LINK_INVALID' });

    const late = await linkToken('once@example.com');
    await identity.context.db
      .updateTable('email_tokens')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('token_hash', '=', hashToken(late))
      .execute();
    const expired = await post('/api/v1/auth/magic-link/verify', { token: late });
    expect(await expired.json()).toMatchObject({ code: 'MAGIC_LINK_INVALID' });

    const metrics = await (await fetch(`${identity.url}/metrics`)).text();
    expect(metrics).toContain(
      'qtiauth_auth_magic_links_total{event="expired",service="identity"} 1',
    );
  });

  it('refuses accounts under the parental consent age without keeping them', async () => {
    const verify = await post('/api/v1/auth/magic-link/verify', {
      token: await linkToken('child@example.com'),
    });
    const { signup_token: signupToken } = (await verify.json()) as { signup_token: string };
    const refused = await post('/api/v1/auth/magic-link/signup', {
      signup_token: signupToken,
      date_of_birth: `${String(new Date().getUTCFullYear() - 10)}-01-01`,
    });
    expect(await refused.json()).toMatchObject({ code: 'PARENTAL_CONSENT_UNAVAILABLE' });
    const users = await identity.context.db
      .selectFrom('users')
      .select('id')
      .where('email_normalized', '=', 'child@example.com')
      .execute();
    expect(users).toEqual([]);
  });

  it('asks which account to use when an address has several, and enforces accounts.max_per_email', async () => {
    const first = await signUp('shared@gmail.com');
    const verify = await post('/api/v1/auth/magic-link/verify', {
      token: await linkToken('other@gmail.com'),
    });
    const { signup_token: signupToken } = (await verify.json()) as { signup_token: string };
    await identity.context.db
      .insertInto('users')
      .values({
        id: randomUUIDv7(),
        state: 'active',
        email: 'Shared+2@gmail.com',
        email_normalized: 'shared@gmail.com',
        email_verified_at: new Date(),
        date_of_birth: '1980-01-01',
        locale: null,
      })
      .execute();

    const token = await linkToken('s.h.a.r.e.d@gmail.com');
    const choose = await post('/api/v1/auth/magic-link/verify', { token });
    const choice = (await choose.json()) as { status: string; accounts: { user_id: string }[] };
    expect(choice.status).toBe('choose_account');
    expect(choice.accounts).toHaveLength(2);
    const chosen = await post('/api/v1/auth/magic-link/verify', { token, user_id: first.userId });
    expect(await chosen.json()).toMatchObject({ status: 'signed_in', user_id: first.userId });

    await identity.context.db
      .updateTable('email_tokens')
      .set({ email_normalized: 'shared@gmail.com' })
      .where('token_hash', '=', hashToken(signupToken))
      .execute();
    const limited = await post('/api/v1/auth/magic-link/signup', {
      signup_token: signupToken,
      date_of_birth: '1990-01-01',
    });
    expect(await limited.json()).toMatchObject({ code: 'ACCOUNT_LIMIT_REACHED' });
  });
});

describe('sessions', () => {
  it('lists sessions newest first and marks the current one', async () => {
    const older = await signUp('lister@example.com');
    const newer = await signIn('lister@example.com');
    const response = await call('/api/v1/sessions?limit=1', {
      as: signedInAs(newer.userId, newer.sessionId),
    });
    const page = (await response.json()) as {
      items: { id: string; current: boolean; user_agent: string }[];
      next_cursor: string | null;
    };
    expect(page.items).toEqual([
      expect.objectContaining({
        id: newer.sessionId,
        current: true,
        user_agent: 'Integration/1.0',
      }),
    ]);
    const next = await call(`/api/v1/sessions?limit=1&cursor=${page.next_cursor ?? ''}`, {
      as: signedInAs(newer.userId, newer.sessionId),
    });
    expect(await next.json()).toMatchObject({
      items: [{ id: older.sessionId, current: false }],
      next_cursor: null,
    });
  });

  it('revokes one, the others or all, and resolves them no more', async () => {
    const a = await signUp('revoker@example.com');
    const b = await signIn('revoker@example.com');
    const c = await signIn('revoker@example.com');
    const asA = signedInAs(a.userId, a.sessionId);

    const one = await call(`/api/v1/sessions/${b.sessionId}`, { method: 'DELETE', as: asA });
    expect(one.status).toBe(204);
    expect(one.headers.get(REVOKED_SESSIONS_HEADER)).toBe(b.sessionId);
    expect(one.headers.has(SESSION_CLEAR_HEADER)).toBe(false);
    expect(await resolve(b.token)).toBeNull();
    const again = await call(`/api/v1/sessions/${b.sessionId}`, { method: 'DELETE', as: asA });
    expect(await again.json()).toMatchObject({ code: 'SESSION_NOT_FOUND' });

    const others = await post('/api/v1/sessions/revoke-others', undefined, asA);
    expect(await others.json()).toEqual({ revoked: 1 });
    expect(await resolve(c.token)).toBeNull();
    expect(await resolve(a.token)).not.toBeNull();

    const all = await post('/api/v1/sessions/revoke-all', undefined, asA);
    expect(all.headers.get(SESSION_CLEAR_HEADER)).toBe('1');
    expect(await resolve(a.token)).toBeNull();
  });

  it('ends the oldest session when a sign-in goes over sessions.max_per_user', async () => {
    const first = await signUp('evicted@example.com');
    await signIn('evicted@example.com');
    await signIn('evicted@example.com');
    const fourth = await signIn('evicted@example.com');
    expect(fourth.response.headers.get(REVOKED_SESSIONS_HEADER)).toBe(first.sessionId);
    expect(await resolve(first.token)).toBeNull();
  });

  it('signs out, clearing the cookie', async () => {
    const user = await signUp('leaver@example.com');
    const response = await post(
      '/api/v1/auth/logout',
      undefined,
      signedInAs(user.userId, user.sessionId),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get(SESSION_CLEAR_HEADER)).toBe('1');
    expect(response.headers.get(REVOKED_SESSIONS_HEADER)).toBe(user.sessionId);
    expect(await resolve(user.token)).toBeNull();
  });

  it('ends sessions that stay idle past cookies.idle_timeout', async () => {
    const user = await signUp('idle@example.com');
    await identity.context.db
      .updateTable('sessions')
      .set({ last_active_at: new Date(Date.now() - 31 * 86_400_000) })
      .where('id', '=', user.sessionId)
      .execute();
    expect(await resolve(user.token)).toBeNull();
  });
});

describe('events, retention and data rights', () => {
  it('writes events that match their schemas', async () => {
    const events = await checkOutboxContract(identity.context.db, await loadEventCatalog());
    expect(new Set(events.map((event) => event.type))).toEqual(
      new Set([
        'qtiauth.identity.user.created.v1',
        'qtiauth.identity.session.created.v1',
        'qtiauth.identity.session.revoked.v1',
      ]),
    );
  });

  it('deletes old sessions and tokens on retention.sweep', async () => {
    const user = await signUp('sweep@example.com');
    const old = new Date(Date.now() - 40 * 86_400_000);
    await identity.context.db
      .updateTable('sessions')
      .set({ revoked_at: old, revoked_reason: 'logout' })
      .where('id', '=', user.sessionId)
      .execute();
    await identity.context.db
      .updateTable('email_tokens')
      .set({ expires_at: old })
      .where('email_normalized', '=', 'sweep@example.com')
      .execute();

    await publishCronTick(gateway.js, 'retention.sweep', new Date());

    await vi.waitFor(async () => {
      const sessions = await identity.context.db
        .selectFrom('sessions')
        .select('id')
        .where('id', '=', user.sessionId)
        .execute();
      expect(sessions).toEqual([]);
    });
    const tokens = await identity.context.db
      .selectFrom('email_tokens')
      .select('id')
      .where('email_normalized', '=', 'sweep@example.com')
      .execute();
    expect(tokens).toEqual([]);
    const bindings = await identity.context.db
      .selectFrom('session_bindings')
      .select('id')
      .where('session_id', '=', user.sessionId)
      .execute();
    expect(bindings).toEqual([]);
  });

  it('exports and erases a user', async () => {
    const user = await signUp('rights@example.com', '1985-07-04');
    const exported = await rpcRequest<UserExport>(gateway, 'identity', EXPORT_USER_METHOD, {
      user_id: user.userId,
    });
    expect(exported).toMatchObject({
      status: 'ok',
      data: {
        service: 'identity',
        data: {
          account: { email: 'rights@example.com', date_of_birth: '1985-07-04' },
          sign_in_methods: [{ type: 'magic_link' }],
          sessions: [{ id: user.sessionId, auth_method: 'magic_link' }],
        },
      },
    });

    await publishEvent(
      gateway.js,
      createEvent({
        type: USER_DELETED_EVENT,
        actor: { type: 'system', id: 'identity' },
        subject: { type: 'user', id: user.userId },
        data: {},
      }),
    );
    await vi.waitFor(async () => {
      expect(await resolve(user.token)).toBeNull();
      const rows = await identity.context.db
        .selectFrom('users')
        .select('id')
        .where('id', '=', user.userId)
        .execute();
      expect(rows).toEqual([]);
    });
  });

  it('reports accounts and sessions in its metrics', async () => {
    await vi.waitFor(async () => {
      const metrics = await (await fetch(`${identity.url}/metrics`)).text();
      expect(metrics).toMatch(/qtiauth_accounts\{state="active",service="identity"\} [1-9]/);
      expect(metrics).toMatch(/qtiauth_sessions_active\{service="identity"\} [1-9]/);
      expect(metrics).toContain('qtiauth_auth_signups_total{method="magic_link",age_band="adult"');
    });
  });

  it('keeps tokens, addresses and dates of birth out of the logs', () => {
    expect(logs.lines.length).toBeGreaterThan(0);
    assertLogsScrubbed(logs.lines, [
      ...secrets,
      ...secrets.map((secret) => hashToken(secret)),
      'rights@example.com',
      '1985-07-04',
      postgres.getPassword(),
    ]);
  });
});
