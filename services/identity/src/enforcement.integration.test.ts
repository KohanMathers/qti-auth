import { randomUUID } from 'node:crypto';

import { type Bus, connectBus, createEvent, publishEvent, rpcRequest } from '@qtiauth/bus';
import { outboxEvents } from '@qtiauth/bus/testing';
import { sections } from '@qtiauth/config';
import { IDENTITY_EVENTS, SAFETY_EVENTS } from '@qtiauth/events';
import { captureLogs } from '@qtiauth/observability/testing';
import {
  hashSessionToken,
  type Identity,
  RESOLVE_SESSION_METHOD,
  RESOLVE_SESSION_SERVICE,
  type RunningService,
  SESSION_TOKEN_HEADER,
  serviceSchema,
  startService,
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

function signedInAs(
  userId: string,
  sessionId: string,
  state: Identity['account_state'] = 'active',
) {
  return {
    auth: 'session' as const,
    sub: userId,
    sid: sessionId,
    amr: ['email'],
    acr: 'aal1',
    account_state: state,
  };
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
    session: {
      session_id: string;
      account_state: string;
      restrictions: string[];
    } | null;
  }>(gateway, RESOLVE_SESSION_SERVICE, RESOLVE_SESSION_METHOD, {
    binding_token_hash: hashSessionToken(token),
    cookie_scope: HOST,
  });
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

async function publishActioned(
  userId: string,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const actionId = randomUUID();
  await publishEvent(
    gateway.js,
    createEvent({
      type: SAFETY_EVENTS.reportActioned,
      actor: { type: 'user', id: randomUUID() },
      subject: { type: 'report', id: randomUUID() },
      data: {
        report_id: randomUUID(),
        action_id: actionId,
        action,
        rule_id: 'hate',
        target: { type: 'user', id: userId, user_id: userId },
        ...extra,
      },
    }),
  );
  return actionId;
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

describe('safety enforcement', () => {
  it('bans from safety.report.actioned and limits the account to me, logout and data rights', async () => {
    const user = await signUp('banned-moderation@example.com');
    await publishActioned(user.userId, 'ban');
    await vi.waitFor(async () => {
      const session = await resolve(user.token);
      expect(session?.account_state).toBe('banned');
    });

    const me = await call('/api/v1/me', { as: signedInAs(user.userId, user.sessionId, 'banned') });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ account_state: 'banned', restrictions: [] });

    const username = await post(
      '/api/v1/me/username',
      { username: 'BannedName' },
      signedInAs(user.userId, user.sessionId, 'banned'),
    );
    expect(await username.json()).toMatchObject({ code: 'ACCOUNT_STATE_NOT_ALLOWED' });

    const logout = await post(
      '/api/v1/auth/logout',
      undefined,
      signedInAs(user.userId, user.sessionId, 'banned'),
    );
    expect(logout.status).toBe(204);

    expect((await outboxEvents(identity.context.db)).map((event) => event.type)).toContain(
      IDENTITY_EVENTS.userBanned,
    );
  });

  it('puts named restrictions on the session and blocks username changes', async () => {
    const user = await signUp('restricted-moderation@example.com');
    await post(
      '/api/v1/me/username',
      { username: 'BeforeRestrict' },
      signedInAs(user.userId, user.sessionId),
    );
    await publishActioned(user.userId, 'restrict', { restrictions: ['chat', 'username_change'] });
    await vi.waitFor(async () => {
      const session = await resolve(user.token);
      expect(session?.restrictions).toEqual(['chat', 'username_change']);
    });

    const me = await call('/api/v1/me', { as: signedInAs(user.userId, user.sessionId) });
    expect(await me.json()).toMatchObject({ restrictions: ['chat', 'username_change'] });

    const change = await post(
      '/api/v1/me/username',
      { username: 'AfterRestrict' },
      { ...signedInAs(user.userId, user.sessionId), restrictions: ['chat', 'username_change'] },
    );
    expect(await change.json()).toMatchObject({ code: 'ACCOUNT_RESTRICTED' });
  });

  it('locks from safety.csea.enforced', async () => {
    const locked = await signUp('locked-csea@example.com');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await publishEvent(
      gateway.js,
      createEvent({
        type: SAFETY_EVENTS.cseaEnforced,
        actor: { type: 'user', id: randomUUID() },
        subject: { type: 'report', id: randomUUID() },
        data: {
          report_id: randomUUID(),
          action_id: randomUUID(),
          action: 'lock',
          rule_id: 'protective',
          target: { type: 'user', id: locked.userId, user_id: locked.userId },
          expires_at: expiresAt,
        },
      }),
    );
    await vi.waitFor(async () => {
      expect((await resolve(locked.token))?.account_state).toBe('locked');
    });
  });

  it('locks, forces a username reset, and lifts a ban when an appeal succeeds', async () => {
    const locked = await signUp('locked-moderation@example.com');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await publishActioned(locked.userId, 'lock', { expires_at: expiresAt });
    await vi.waitFor(async () => {
      expect((await resolve(locked.token))?.account_state).toBe('locked');
    });

    const reset = await signUp('reset-moderation@example.com');
    await post(
      '/api/v1/me/username',
      { username: 'NeedsReset' },
      signedInAs(reset.userId, reset.sessionId),
    );
    await publishActioned(reset.userId, 'force_username_reset');
    await vi.waitFor(async () => {
      const account = await identity.context.db
        .selectFrom('users')
        .select(['username', 'username_reset_required'])
        .where('id', '=', reset.userId)
        .executeTakeFirstOrThrow();
      expect(account.username).toBeNull();
      expect(account.username_reset_required).toBe(true);
    });

    const banned = await signUp('appeal-moderation@example.com');
    const actionId = await publishActioned(banned.userId, 'proscribed_org_removal', {
      reason_code: 'icu_h1',
    });
    await vi.waitFor(async () => {
      expect((await resolve(banned.token))?.account_state).toBe('banned');
    });
    await publishEvent(
      gateway.js,
      createEvent({
        type: SAFETY_EVENTS.appealResolved,
        actor: { type: 'user', id: randomUUID() },
        subject: { type: 'appeal', id: randomUUID() },
        data: {
          appeal_id: randomUUID(),
          action_id: actionId,
          action: 'proscribed_org_removal',
          user_id: banned.userId,
          outcome: 'lifted',
        },
      }),
    );
    await vi.waitFor(async () => {
      expect((await resolve(banned.token))?.account_state).toBe('active');
    });
  });

  it('leaves the account alone for warn and remove_content', async () => {
    const user = await signUp('warn-moderation@example.com');
    await publishActioned(user.userId, 'warn');
    await publishActioned(user.userId, 'remove_content', {
      target: { type: 'content', id: 'post-1', user_id: user.userId },
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    expect((await resolve(user.token))?.account_state).toBe('active');
  });
});
