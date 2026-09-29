import { randomUUIDv7 } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Bus,
  connectBus,
  createEvent,
  publishCronTick,
  publishEvent,
  rpcRequest,
} from '@qtiauth/bus';
import { checkOutboxContract } from '@qtiauth/bus/testing';
import { solveAltcha } from '@qtiauth/captcha';
import { sections } from '@qtiauth/config';
import { AUDIT_EVENTS, IDENTITY_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import {
  EXPORT_USER_METHOD,
  FAMILY_TOKEN_HEADER,
  hashSessionToken,
  type Identity,
  RESOLVE_SESSION_METHOD,
  RESOLVE_SESSION_SERVICE,
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
import { natsUrl, startNats, startPostgres, startValkey } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Database } from './database.ts';
import { ACTIVITY_SUMMARY_JOB } from './family.ts';
import { GRADUATION_JOB, REMOVAL_REMINDERS_JOB } from './graduation.ts';
import { GET_LEGAL_HOLD_METHOD, PLACE_LEGAL_HOLD_METHOD } from './legal-holds.ts';
import { PURGE_JOB } from './lifecycle.ts';
import { EXPIRE_PENDING_JOB } from './parental.ts';
import { softwarePasskey } from './passkey-testing.ts';
import { definition } from './service.ts';
import { identityService } from './start.ts';
import { type CapturedEmails, captureEmails, grantUser } from './testing.ts';
import { hashToken } from './tokens.ts';
import { decodeBase32, totpAt } from './totp.ts';

const HOST = 'me.example.com';
const SUPPORT = 'support.example.com';
const key = generateIdentityKey();

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let valkey: Awaited<ReturnType<typeof startValkey>>;
let gateway: Bus;
let notifier: Bus;
let emails: CapturedEmails;
let identity: RunningService<typeof definition, Database>;
let backupDir: string;
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

async function resolve(token: string, cookieScope = HOST) {
  const result = await rpcRequest<{ session: { session_id: string } | null }>(
    gateway,
    RESOLVE_SESSION_SERVICE,
    RESOLVE_SESSION_METHOD,
    { binding_token_hash: hashSessionToken(token), cookie_scope: cookieScope },
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

const PASSWORD = 'long-enough-secret';

async function registerPassword(
  email: string,
  password = PASSWORD,
  dateOfBirth = '1990-05-01',
): Promise<{ userId: string; verifyToken: string }> {
  const signup = await post('/api/v1/auth/password/signup', {
    email,
    password,
    date_of_birth: dateOfBirth,
  });
  expect(signup.status).toBe(201);
  const body = (await signup.json()) as { user_id: string };
  const verifyToken = (await emails.nextLink(email)).searchParams.get('token') ?? '';
  secrets.push(verifyToken);
  return { userId: body.user_id, verifyToken };
}

async function verifyPasswordEmail(token: string): Promise<SignedIn> {
  const verify = await post('/api/v1/auth/email/verify', { token });
  expect(verify.status).toBe(200);
  return finish(verify);
}

async function loginPassword(email: string, password = PASSWORD): Promise<Response> {
  return post('/api/v1/auth/password/login', { email, password });
}

beforeAll(async () => {
  backupDir = await mkdtemp(join(tmpdir(), 'qtiauth-ledger-'));
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
      surfaces: {
        account: { hosts: [HOST] },
        support: { hosts: [SUPPORT], base_path: '/' },
      },
      valkey: { host: valkey.getHost(), port: valkey.getPort() },
      sessions: { max_per_user: 3 },
      password: {
        argon2: { memory_kib: 8, iterations: 1 },
        breach_check: false,
        failure_delay: { step: '1ms', max: '1ms' },
      },
      captcha: { after: 1000, altcha: { hmac_key: 'integration-captcha-key', max_number: 400 } },
      security: { encryption_key: Buffer.alloc(32, 9).toString('base64') },
      backups: { directory: backupDir },
    }),
  });
});

afterAll(async () => {
  await identity.stop();
  await emails.stop();
  await Promise.all([gateway.close(), notifier.close()]);
  await Promise.all([postgres.stop(), nats.stop(), valkey.stop()]);
  await rm(backupDir, { recursive: true, force: true });
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
    expect(link.pathname).toBe('/verify');
    await emails.nextLink('nobody@example.com');
  });
});

describe('signing up and signing in', () => {
  it('creates an active account after the date of birth, and signs in with a bound session', async () => {
    const signedUp = await signUp('new@example.com', '2011-01-01');
    expect(signedUp.response.headers.get(SESSION_EXPIRES_HEADER)).toBeTruthy();

    const session = await rpcRequest(gateway, RESOLVE_SESSION_SERVICE, RESOLVE_SESSION_METHOD, {
      binding_token_hash: hashSessionToken(signedUp.token),
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
          two_factor_enrolment_required: false,
        },
      },
    });
    const otherHost = await rpcRequest(gateway, RESOLVE_SESSION_SERVICE, RESOLVE_SESSION_METHOD, {
      binding_token_hash: hashSessionToken(signedUp.token),
      cookie_scope: 'elsewhere.example.com',
    });
    expect(otherHost).toMatchObject({ status: 'ok', data: { session: null } });

    const me = await call('/api/v1/me', { as: signedInAs(signedUp.userId, signedUp.sessionId) });
    expect(await me.json()).toMatchObject({
      id: signedUp.userId,
      email: 'new@example.com',
      email_verified: true,
      username: null,
      account_state: 'active',
      age_band: '13_to_15',
      deletion_requested_at: null,
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

  it('asks for a parent or guardian email below the consent age, and keeps nothing without one', async () => {
    const verify = await post('/api/v1/auth/magic-link/verify', {
      token: await linkToken('child@example.com'),
    });
    const { signup_token: signupToken } = (await verify.json()) as { signup_token: string };
    const refused = await post('/api/v1/auth/magic-link/signup', {
      signup_token: signupToken,
      date_of_birth: `${String(new Date().getUTCFullYear() - 10)}-01-01`,
    });
    expect(await refused.json()).toMatchObject({ code: 'GUARDIAN_EMAIL_REQUIRED' });
    const same = await post('/api/v1/auth/magic-link/signup', {
      signup_token: signupToken,
      date_of_birth: `${String(new Date().getUTCFullYear() - 10)}-01-01`,
      guardian_email: 'child@example.com',
    });
    expect(await same.json()).toMatchObject({ code: 'GUARDIAN_EMAIL_INVALID' });
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

describe('passwords', () => {
  it('creates a pending account, verifies the email, then signs in', async () => {
    const registered = await registerPassword('pwd-new@example.com');
    const row = await identity.context.db
      .selectFrom('users')
      .select(['state', 'email_verified_at'])
      .where('id', '=', registered.userId)
      .executeTakeFirst();
    expect(row).toMatchObject({ state: 'pending_email_verification', email_verified_at: null });

    const beforeVerify = await loginPassword('pwd-new@example.com');
    expect(beforeVerify.status).toBe(200);
    const pending = await finish(beforeVerify);
    const pendingMe = await call('/api/v1/me', {
      as: signedInAs(pending.userId, pending.sessionId),
    });
    expect(await pendingMe.json()).toMatchObject({
      account_state: 'pending_email_verification',
      email_verified: false,
    });

    const verified = await verifyPasswordEmail(registered.verifyToken);
    expect(verified.userId).toBe(registered.userId);
    const me = await call('/api/v1/me', {
      as: { ...signedInAs(verified.userId, verified.sessionId), amr: ['pwd'] },
    });
    expect(await me.json()).toMatchObject({
      email: 'pwd-new@example.com',
      email_verified: true,
      account_state: 'active',
      session: { amr: ['pwd'], acr: 'aal1' },
    });
  });

  it('answers identically for an unknown address and a wrong password', async () => {
    await registerPassword('pwd-known@example.com');
    const unknown = await loginPassword('pwd-nobody@example.com', 'wrong-password-ok');
    const wrong = await loginPassword('pwd-known@example.com', 'wrong-password-ok');
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.headers.get('content-type')).toBe(wrong.headers.get('content-type'));
    const withoutRequestId = (text: string) => text.replace(/"request_id":"[^"]*"/, '');
    expect(withoutRequestId(await unknown.text())).toBe(withoutRequestId(await wrong.text()));
    expect(JSON.parse(await (await loginPassword('pwd-nobody@example.com')).text())).toMatchObject({
      code: 'CREDENTIALS_INCORRECT',
    });
  });

  it('takes indistinguishably long for an unknown address and a wrong password', async () => {
    await registerPassword('pwd-timing@example.com');
    const samples = 20;
    const unknown: number[] = [];
    const wrong: number[] = [];
    for (let i = 0; i < samples; i++) {
      let start = performance.now();
      await (
        await loginPassword(`pwd-missing-${String(i)}@example.com`, 'wrong-password-ok')
      ).text();
      unknown.push(performance.now() - start);
      start = performance.now();
      await (await loginPassword('pwd-timing@example.com', 'wrong-password-ok')).text();
      wrong.push(performance.now() - start);
    }
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = (values: number[]) => {
      const avg = mean(values);
      return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
    };
    const diff = Math.abs(mean(unknown) - mean(wrong));
    const se = Math.sqrt(variance(unknown) / samples + variance(wrong) / samples);
    expect(diff).toBeLessThan(3 * se + 25);
  });

  it('rejects passwords that contain the email local part', async () => {
    const response = await post('/api/v1/auth/password/signup', {
      email: 'samsmith@example.com',
      password: 'xxsamsmithxx',
      date_of_birth: '1990-01-01',
    });
    expect(await response.json()).toMatchObject({
      code: 'PASSWORD_REJECTED',
      reason: 'contains_identifier',
    });
  });

  it('adds a password after a recent magic-link sign-in, and changes it with the current one', async () => {
    const user = await signUp('pwd-add@example.com');
    const added = await post(
      '/api/v1/me/password',
      { password: PASSWORD },
      signedInAs(user.userId, user.sessionId),
    );
    expect(added.status).toBe(204);

    const changed = await post(
      '/api/v1/me/password',
      { password: 'another-long-secret', current_password: PASSWORD },
      signedInAs(user.userId, user.sessionId),
    );
    expect(changed.status).toBe(204);

    const login = await loginPassword('pwd-add@example.com', 'another-long-secret');
    expect(login.status).toBe(200);
    secrets.push(login.headers.get(SESSION_TOKEN_HEADER) ?? '');
  });

  it('needs a recent magic-link sign-in to add a password', async () => {
    const user = await signUp('pwd-stepup@example.com');
    await identity.context.db
      .updateTable('sessions')
      .set({ created_at: new Date(Date.now() - 20 * 60_000) })
      .where('id', '=', user.sessionId)
      .execute();
    const refused = await post(
      '/api/v1/me/password',
      { password: PASSWORD },
      signedInAs(user.userId, user.sessionId),
    );
    expect(await refused.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('resets a password and revokes other sessions unless keep_other_sessions is true', async () => {
    const first = await registerPassword('pwd-reset@example.com');
    const signedInUser = await verifyPasswordEmail(first.verifyToken);
    const second = await finish(await loginPassword('pwd-reset@example.com'));

    const forgot = await post('/api/v1/auth/password/forgot', { email: 'pwd-reset@example.com' });
    expect(forgot.status).toBe(202);
    const unknown = await post('/api/v1/auth/password/forgot', {
      email: 'pwd-missing@example.com',
    });
    expect(await unknown.text()).toBe(await forgot.text());
    secrets.push(
      (await emails.nextLink('pwd-missing@example.com')).searchParams.get('token') ?? '',
    );

    const token = (await emails.nextLink('pwd-reset@example.com')).searchParams.get('token') ?? '';
    secrets.push(token);
    const reset = await post('/api/v1/auth/password/reset', {
      token,
      password: 'brand-new-secret1',
    });
    expect(reset.status).toBe(200);
    const afterReset = await finish(reset);
    expect(await resolve(signedInUser.token)).toBeNull();
    expect(await resolve(second.token)).toBeNull();
    expect(await resolve(afterReset.token)).not.toBeNull();

    const keepForgot = await post('/api/v1/auth/password/forgot', {
      email: 'pwd-reset@example.com',
    });
    expect(keepForgot.status).toBe(202);
    const keepToken =
      (await emails.nextLink('pwd-reset@example.com')).searchParams.get('token') ?? '';
    secrets.push(keepToken);
    const kept = await finish(await loginPassword('pwd-reset@example.com', 'brand-new-secret1'));
    const keepReset = await post('/api/v1/auth/password/reset', {
      token: keepToken,
      password: 'kept-other-secret1',
      keep_other_sessions: true,
    });
    expect(keepReset.status).toBe(200);
    secrets.push(keepReset.headers.get(SESSION_TOKEN_HEADER) ?? '');
    expect(await resolve(kept.token)).not.toBeNull();
  });
});

describe('email change', () => {
  it('confirms the new address and lets the previous one undo it', async () => {
    const user = await signUp('old-mail@example.com');
    const asUser = signedInAs(user.userId, user.sessionId);
    const unchanged = await post('/api/v1/me/email', { email: 'old-mail@example.com' }, asUser);
    expect(await unchanged.json()).toMatchObject({ code: 'EMAIL_UNCHANGED' });

    const start = await post('/api/v1/me/email', { email: 'new-mail@example.com' }, asUser);
    expect(start.status).toBe(202);
    const confirmLink = new URL(
      String((await emails.nextJob('new-mail@example.com', 'email_change')).variables['link']),
    );
    const revertLink = new URL(
      String(
        (await emails.nextJob('old-mail@example.com', 'email_change_notice')).variables['link'],
      ),
    );
    expect(confirmLink.pathname).toBe('/verify');
    expect(revertLink.pathname).toBe('/revert-email');
    const confirmToken = confirmLink.searchParams.get('token') ?? '';
    const revertToken = revertLink.searchParams.get('token') ?? '';
    secrets.push(confirmToken, revertToken);

    const confirmed = await post('/api/v1/auth/email/change', { token: confirmToken });
    expect(await confirmed.json()).toMatchObject({
      status: 'changed',
      email: 'new-mail@example.com',
    });
    expect(await (await call('/api/v1/me', { as: asUser })).json()).toMatchObject({
      email: 'new-mail@example.com',
      email_verified: true,
    });

    const reverted = await post('/api/v1/auth/email/revert', { token: revertToken });
    expect(await reverted.json()).toMatchObject({
      status: 'reverted',
      email: 'old-mail@example.com',
    });
    expect(await (await call('/api/v1/me', { as: asUser })).json()).toMatchObject({
      email: 'old-mail@example.com',
    });
  });
});

describe('passkeys and two-factor', () => {
  const origin = `https://${HOST}`;

  it('asks for TOTP after a password sign-in, then the session is aal2', async () => {
    const registered = await registerPassword('totp@example.com');
    const user = await verifyPasswordEmail(registered.verifyToken);
    const asUser = signedInAs(user.userId, user.sessionId);
    const start = await post('/api/v1/me/totp/start', {}, asUser);
    expect(start.status).toBe(200);
    const enrolment = (await start.json()) as { challenge: string; secret: string };
    secrets.push(enrolment.challenge, enrolment.secret);
    const secret = decodeBase32(enrolment.secret);
    expect(secret).toBeInstanceOf(Buffer);
    if (!(secret instanceof Buffer)) return;
    const confirm = await post(
      '/api/v1/me/totp',
      { challenge: enrolment.challenge, code: totpAt(secret, new Date()) },
      asUser,
    );
    const enabled = (await confirm.json()) as { recovery_codes: string[] };
    expect(confirm.status).toBe(200);
    expect(enabled.recovery_codes).toHaveLength(10);
    secrets.push(...enabled.recovery_codes);

    const login = await loginPassword('totp@example.com');
    const next = (await login.json()) as {
      status: string;
      challenge: string;
      methods: string[];
    };
    expect(next).toMatchObject({ status: 'second_factor_required', methods: ['totp', 'recovery'] });
    secrets.push(next.challenge);
    expect(login.headers.get(SESSION_TOKEN_HEADER)).toBeNull();

    const finished = await post('/api/v1/auth/2fa', {
      challenge: next.challenge,
      totp: totpAt(secret, new Date()),
    });
    expect(finished.status).toBe(200);
    const session = await finish(finished);
    expect(await resolve(session.token)).toMatchObject({ acr: 'aal2', amr: ['pwd', 'otp'] });
  });

  it('signs a passkey-only account in at aal2', async () => {
    const user = await signUp('passkey@example.com');
    const authenticator = await softwarePasskey(origin);
    const asUser = signedInAs(user.userId, user.sessionId);
    const start = await post('/api/v1/me/passkeys/register/start', {}, asUser);
    const creation = (await start.json()) as {
      challenge: string;
      options: Parameters<typeof authenticator.register>[0];
    };
    secrets.push(creation.challenge);
    const attested = await authenticator.register(creation.options);
    const registered = await post(
      '/api/v1/me/passkeys/register',
      { challenge: creation.challenge, name: 'Laptop', response: attested },
      asUser,
    );
    expect(registered.status).toBe(201);

    const begin = await post('/api/v1/auth/passkey/authenticate/start', {});
    const assertion = (await begin.json()) as {
      challenge: string;
      options: Parameters<typeof authenticator.authenticate>[0];
    };
    secrets.push(assertion.challenge);
    const asserted = await authenticator.authenticate(assertion.options);
    const signedIn = await post('/api/v1/auth/passkey/authenticate', {
      challenge: assertion.challenge,
      response: asserted,
    });
    expect(signedIn.status).toBe(200);
    const session = await finish(signedIn);
    expect(await resolve(session.token)).toMatchObject({
      user_id: user.userId,
      acr: 'aal2',
      amr: ['webauthn'],
      two_factor_enrolment_required: false,
    });
  });

  it('marks staff without a second factor as needing enrolment', async () => {
    const user = await signUp('staff-2fa@example.com');
    await grantUser(identity.context.db, user.userId, ['users.read']);
    expect(await resolve(user.token)).toMatchObject({
      two_factor_enrolment_required: true,
      permissions: ['users.read'],
    });
  });
});

describe('captcha', () => {
  const ip = '198.51.100.80';

  function postFrom(path: string, body: unknown) {
    return call(path, {
      method: 'POST',
      headers: { 'x-forwarded-for': ip, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function trip(scope: 'password' | 'magic_link' | 'signup') {
    await identity.context.db
      .insertInto('auth_failures')
      .values({ kind: 'ip', key: ip, scope, failures: 1000, updated_at: new Date() })
      .onConflict((conflict) =>
        conflict.columns(['kind', 'key', 'scope']).doUpdateSet({
          failures: 1000,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  it('does not ask for a CAPTCHA before the threshold', async () => {
    await registerPassword('captcha-early@example.com');
    const login = await postFrom('/api/v1/auth/password/login', {
      email: 'captcha-early@example.com',
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    secrets.push(login.headers.get(SESSION_TOKEN_HEADER) ?? '');
    const status = await call(`/api/v1/captcha?action=password_login`, {
      headers: { 'x-forwarded-for': ip },
    });
    expect(await status.json()).toMatchObject({ required: false, provider: 'altcha' });
  });

  it('requires a solved Altcha challenge after the threshold and until it is solved', async () => {
    await registerPassword('captcha-login@example.com');
    await trip('password');
    const missing = await postFrom('/api/v1/auth/password/login', {
      email: 'captcha-login@example.com',
      password: PASSWORD,
    });
    const required = (await missing.json()) as {
      code: string;
      provider: string;
      challenge: {
        algorithm: 'SHA-256';
        challenge: string;
        salt: string;
        signature: string;
        maxnumber: number;
      };
    };
    expect(required).toMatchObject({ code: 'CAPTCHA_REQUIRED', provider: 'altcha' });

    const invalid = await postFrom('/api/v1/auth/password/login', {
      email: 'captcha-login@example.com',
      password: PASSWORD,
      captcha: 'nope',
    });
    expect(await invalid.json()).toMatchObject({ code: 'CAPTCHA_INVALID' });

    const solved = await postFrom('/api/v1/auth/password/login', {
      email: 'captcha-login@example.com',
      password: PASSWORD,
      captcha: solveAltcha(required.challenge),
    });
    expect(solved.status).toBe(200);
    secrets.push(solved.headers.get(SESSION_TOKEN_HEADER) ?? '');
  });

  it('protects magic-link start and password signup the same way', async () => {
    await trip('magic_link');
    const start = await postFrom('/api/v1/auth/magic-link/start', {
      email: 'captcha-ml@example.com',
    });
    const required = (await start.json()) as {
      code: string;
      challenge: {
        algorithm: 'SHA-256';
        challenge: string;
        salt: string;
        signature: string;
        maxnumber: number;
      };
    };
    expect(required.code).toBe('CAPTCHA_REQUIRED');
    const sent = await postFrom('/api/v1/auth/magic-link/start', {
      email: 'captcha-ml@example.com',
      captcha: solveAltcha(required.challenge),
    });
    expect(sent.status).toBe(202);
    secrets.push((await emails.nextLink('captcha-ml@example.com')).searchParams.get('token') ?? '');

    await trip('signup');
    const signup = await postFrom('/api/v1/auth/password/signup', {
      email: 'captcha-signup@example.com',
      password: PASSWORD,
      date_of_birth: '1990-01-01',
    });
    expect(await signup.json()).toMatchObject({ code: 'CAPTCHA_REQUIRED' });
  });
});

describe('events, retention and data rights', () => {
  it('writes events that match their schemas', async () => {
    const events = await checkOutboxContract(identity.context.db, await loadEventCatalog());
    expect(new Set(events.map((event) => event.type))).toEqual(
      new Set([
        IDENTITY_EVENTS.userCreated,
        IDENTITY_EVENTS.sessionCreated,
        IDENTITY_EVENTS.sessionRevoked,
        IDENTITY_EVENTS.legalVersionPublished,
        AUDIT_EVENTS.recorded,
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
          legal_acceptances: expect.arrayContaining([
            expect.objectContaining({ document_id: 'terms', method: 'signup' }),
          ]) as unknown,
        },
      },
    });

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
      expect(await resolve(user.token)).toBeNull();
      const rows = await identity.context.db
        .selectFrom('users')
        .select('id')
        .where('id', '=', user.userId)
        .execute();
      expect(rows).toEqual([]);
    });
  });

  it('schedules deletion, cancels it on sign-in, then purges to a ledger entry', async () => {
    const user = await signUp('delete-me@example.com');
    const requested = await post(
      '/api/v1/me/deletion',
      undefined,
      signedInAs(user.userId, user.sessionId),
    );
    expect(requested.status).toBe(204);
    expect(requested.headers.get(SESSION_CLEAR_HEADER)).toBe('1');
    const pending = await call('/api/v1/me', {
      as: signedInAs(user.userId, user.sessionId),
    });
    expect(await pending.json()).toMatchObject({
      account_state: 'pending_deletion',
      deletion_requested_at: expect.any(String) as unknown,
    });

    const again = await signIn('delete-me@example.com');
    expect(again.userId).toBe(user.userId);
    const restored = await call('/api/v1/me', {
      as: signedInAs(again.userId, again.sessionId),
    });
    expect(await restored.json()).toMatchObject({
      account_state: 'active',
      deletion_requested_at: null,
    });

    expect(
      (await post('/api/v1/me/deletion', undefined, signedInAs(again.userId, again.sessionId)))
        .status,
    ).toBe(204);
    await identity.context.db
      .updateTable('users')
      .set({ deletion_requested_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where('id', '=', again.userId)
      .execute();
    await publishCronTick(gateway.js, PURGE_JOB, new Date());
    await vi.waitFor(async () => {
      const rows = await identity.context.db
        .selectFrom('users')
        .select('id')
        .where('id', '=', again.userId)
        .execute();
      expect(rows).toEqual([]);
      const ledger = JSON.parse(
        await readFile(join(backupDir, 'deletion-ledger', `${again.userId}.json`), 'utf8'),
      ) as { user_id: string; deleted_at: string };
      expect(ledger).toMatchObject({ user_id: again.userId });
    });
    const metrics = await (await fetch(`${identity.url}/metrics`)).text();
    expect(metrics).toContain(
      'qtiauth_account_deletions_total{event="requested",service="identity"}',
    );
    expect(metrics).toContain(
      'qtiauth_account_deletions_total{event="cancelled",service="identity"}',
    );
    expect(metrics).toContain(
      'qtiauth_account_deletions_total{event="completed",service="identity"}',
    );
  });

  it('keeps a ban or lock when a deletion is cancelled by signing in', async () => {
    const lockedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    for (const [email, state] of [
      ['banned-delete@example.com', 'banned'],
      ['locked-delete@example.com', 'locked'],
    ] as const) {
      const user = await signUp(email);
      await identity.context.db
        .updateTable('users')
        .set({ state, locked_until: state === 'locked' ? lockedUntil : null })
        .where('id', '=', user.userId)
        .execute();
      expect(
        (await post('/api/v1/me/deletion', undefined, signedInAs(user.userId, user.sessionId)))
          .status,
      ).toBe(204);
      await signIn(email);
      const account = await identity.context.db
        .selectFrom('users')
        .select(['state', 'locked_until', 'pre_deletion_state', 'deletion_requested_at'])
        .where('id', '=', user.userId)
        .executeTakeFirstOrThrow();
      expect(account).toEqual({
        state,
        locked_until: state === 'locked' ? lockedUntil : null,
        pre_deletion_state: null,
        deletion_requested_at: null,
      });
    }
  });

  it('emails a zipped export as an attachment when object storage is off', async () => {
    const user = await signUp('export-me@example.com');
    const started = await post(
      '/api/v1/me/export',
      undefined,
      signedInAs(user.userId, user.sessionId),
    );
    expect(started.status).toBe(202);
    const body = (await started.json()) as { id: string; status: string };
    expect(body.status).toBe('pending');
    const job = await emails.nextJob('export-me@example.com', 'data_export_attachment');
    expect(job.attachments).toEqual([
      expect.objectContaining({
        filename: `export-${user.userId}.zip`,
        content_type: 'application/zip',
      }),
    ]);
    expect(job.attachments[0]?.content.length).toBeGreaterThan(0);
    await vi.waitFor(async () => {
      const status = await call(`/api/v1/me/export/${body.id}`, {
        as: signedInAs(user.userId, user.sessionId),
      });
      expect(await status.json()).toMatchObject({ id: body.id, status: 'ready' });
    });
    const metrics = await (await fetch(`${identity.url}/metrics`)).text();
    expect(metrics).toContain('qtiauth_data_exports_total{status="ready",service="identity"}');
  });

  it('keeps a legal hold after the account is erased', async () => {
    const user = await signUp('held@example.com');
    const placed = await rpcRequest<{ hold: { id: string; reason: string } }>(
      gateway,
      'identity',
      PLACE_LEGAL_HOLD_METHOD,
      { user_id: user.userId, reason: 'Open investigation' },
    );
    expect(placed).toMatchObject({
      status: 'ok',
      data: { hold: { user_id: user.userId, reason: 'Open investigation', lifted_at: null } },
    });
    expect(
      (await post('/api/v1/me/deletion', undefined, signedInAs(user.userId, user.sessionId)))
        .status,
    ).toBe(204);
    await identity.context.db
      .updateTable('users')
      .set({ deletion_requested_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where('id', '=', user.userId)
      .execute();
    await publishCronTick(gateway.js, PURGE_JOB, new Date());
    await vi.waitFor(async () => {
      const rows = await identity.context.db
        .selectFrom('users')
        .select('id')
        .where('id', '=', user.userId)
        .execute();
      expect(rows).toEqual([]);
    });
    const hold = await rpcRequest(gateway, 'identity', GET_LEGAL_HOLD_METHOD, {
      user_id: user.userId,
    });
    expect(hold).toMatchObject({
      status: 'ok',
      data: { hold: { user_id: user.userId, reason: 'Open investigation', lifted_at: null } },
    });
  });

  it('reports accounts and sessions in its metrics', async () => {
    await vi.waitFor(async () => {
      const metrics = await (await fetch(`${identity.url}/metrics`)).text();
      expect(metrics).toMatch(/qtiauth_accounts\{state="active",service="identity"\} [1-9]/);
      expect(metrics).toMatch(/qtiauth_sessions_active\{service="identity"\} [1-9]/);
      expect(metrics).toContain('qtiauth_auth_signups_total{method="magic_link",age_band="adult"');
      expect(metrics).toContain('qtiauth_auth_signups_total{method="password",age_band="adult"');
      expect(metrics).toContain('qtiauth_legal_acceptance_pending{service="identity"}');
    });
  });
});

describe('parental consent', () => {
  const childDob = `${String(new Date().getUTCFullYear() - 10)}-01-01`;

  function asChild(userId: string, sessionId: string): Partial<Identity> {
    return {
      ...signedInAs(userId, sessionId),
      account_state: 'pending_parental_consent',
      age_band: 'under_13',
    };
  }

  async function signUpChild(email: string, guardianEmail: string): Promise<SignedIn> {
    const verify = await post('/api/v1/auth/magic-link/verify', { token: await linkToken(email) });
    const next = (await verify.json()) as { signup_token: string };
    secrets.push(next.signup_token);
    const signup = await post('/api/v1/auth/magic-link/signup', {
      signup_token: next.signup_token,
      date_of_birth: childDob,
      guardian_email: guardianEmail,
    });
    expect(signup.status).toBe(201);
    return finish(signup);
  }

  async function consentJob(address: string) {
    const job = await emails.nextJob(address, 'parental_consent');
    const approve = new URL(String(job.variables['approve_link']));
    const decline = new URL(String(job.variables['decline_link']));
    const approveToken = approve.searchParams.get('token') ?? '';
    const declineToken = decline.searchParams.get('token') ?? '';
    secrets.push(approveToken, declineToken);
    return { job, approveToken, declineToken };
  }

  async function waitErased(userId: string): Promise<void> {
    await vi.waitFor(async () => {
      const rows = await identity.context.db
        .selectFrom('users')
        .select('id')
        .where('id', '=', userId)
        .execute();
      expect(rows).toEqual([]);
      const ledger = JSON.parse(
        await readFile(join(backupDir, 'deletion-ledger', `${userId}.json`), 'utf8'),
      ) as { user_id: string };
      expect(ledger).toMatchObject({ user_id: userId });
    });
  }

  it('creates a waiting child account, lets them resend and change the guardian email, then activates on approve', async () => {
    const user = await signUpChild('consent-child@example.com', 'consent-parent@example.com');
    const me = await call('/api/v1/me', { as: asChild(user.userId, user.sessionId) });
    const waiting = (await me.json()) as {
      account_state: string;
      parental_consent: {
        guardian_email: string;
        email_changes_remaining: number;
        expires_at: string;
      };
    };
    expect(waiting).toMatchObject({
      account_state: 'pending_parental_consent',
      parental_consent: {
        guardian_email: 'consent-parent@example.com',
        email_changes_remaining: 3,
      },
    });
    const first = await consentJob('consent-parent@example.com');
    expect(first.job.variables['expires_in_days']).toBe(14);

    const resent = await post(
      '/api/v1/me/parental-consent/resend',
      {},
      asChild(user.userId, user.sessionId),
    );
    expect(resent.status).toBe(202);
    expect(await resent.json()).toMatchObject({ expires_at: waiting.parental_consent.expires_at });
    await consentJob('consent-parent@example.com');

    const changed = await post(
      '/api/v1/me/parental-consent/email',
      { email: 'consent-parent-2@example.com' },
      asChild(user.userId, user.sessionId),
    );
    expect(changed.status).toBe(202);
    expect(await changed.json()).toMatchObject({
      guardian_email: 'consent-parent-2@example.com',
      email_changes_remaining: 2,
    });
    await consentJob('consent-parent-2@example.com');

    for (const n of [3, 4]) {
      const response = await post(
        '/api/v1/me/parental-consent/email',
        { email: `consent-parent-${String(n)}@example.com` },
        asChild(user.userId, user.sessionId),
      );
      expect(response.status).toBe(202);
      await consentJob(`consent-parent-${String(n)}@example.com`);
    }
    const limited = await post(
      '/api/v1/me/parental-consent/email',
      { email: 'consent-parent-5@example.com' },
      asChild(user.userId, user.sessionId),
    );
    expect(await limited.json()).toMatchObject({ code: 'GUARDIAN_EMAIL_CHANGE_LIMIT' });

    const last = await post(
      '/api/v1/me/parental-consent/resend',
      {},
      asChild(user.userId, user.sessionId),
    );
    expect(last.status).toBe(202);
    const { approveToken } = await consentJob('consent-parent-4@example.com');
    const young = await post('/api/v1/auth/parental-consent/approve', {
      token: approveToken,
      date_of_birth: childDob,
    });
    expect(await young.json()).toMatchObject({ code: 'GUARDIAN_NOT_ADULT' });
    const approved = await post('/api/v1/auth/parental-consent/approve', {
      token: approveToken,
      date_of_birth: '1980-01-01',
    });
    expect(approved.status).toBe(204);

    const active = await call('/api/v1/me', { as: signedInAs(user.userId, user.sessionId) });
    expect(await active.json()).toMatchObject({
      account_state: 'active',
      parental_consent: null,
    });
    const legal = await identity.context.db
      .selectFrom('legal_acceptances')
      .select('method')
      .where('user_id', '=', user.userId)
      .execute();
    expect(legal.length).toBeGreaterThan(0);
    expect(legal.every((row) => row.method === 'guardian')).toBe(true);
  });

  it('deletes an unapproved account when the guardian declines, including a ledger entry', async () => {
    const user = await signUpChild('decline-child@example.com', 'decline-parent@example.com');
    const { declineToken } = await consentJob('decline-parent@example.com');
    const declined = await post('/api/v1/auth/parental-consent/decline', { token: declineToken });
    expect(declined.status).toBe(204);
    await waitErased(user.userId);
  });

  it('erases unapproved accounts after parental.pending_ttl, including a ledger entry', async () => {
    const user = await signUpChild('expire-child@example.com', 'expire-parent@example.com');
    await consentJob('expire-parent@example.com');
    await identity.context.db
      .updateTable('parental_consents')
      .set({ requested_at: new Date(Date.now() - 15 * 86_400_000) })
      .where('user_id', '=', user.userId)
      .execute();
    await publishCronTick(gateway.js, EXPIRE_PENDING_JOB, new Date());
    await waitErased(user.userId);
    const metrics = await (await fetch(`${identity.url}/metrics`)).text();
    expect(metrics).toContain(
      'qtiauth_parental_consent_total{result="expired",service="identity"}',
    );
  });

  it('emails the guardian only after a password child’s address is confirmed', async () => {
    const signup = await post('/api/v1/auth/password/signup', {
      email: 'pwd-child@example.com',
      password: PASSWORD,
      date_of_birth: childDob,
      guardian_email: 'pwd-parent@example.com',
    });
    expect(signup.status).toBe(201);
    const verifyToken =
      (await emails.nextLink('pwd-child@example.com')).searchParams.get('token') ?? '';
    secrets.push(verifyToken);
    expect(emails.jobs.filter((job) => job.to.address === 'pwd-parent@example.com')).toEqual([]);
    await verifyPasswordEmail(verifyToken);
    await consentJob('pwd-parent@example.com');
  });
});

describe('family dashboard', () => {
  const childDob = `${String(new Date().getUTCFullYear() - 10)}-01-01`;

  async function signUpChild(email: string, guardianEmail: string): Promise<SignedIn> {
    const verify = await post('/api/v1/auth/magic-link/verify', { token: await linkToken(email) });
    const next = (await verify.json()) as { signup_token: string };
    secrets.push(next.signup_token);
    const signup = await post('/api/v1/auth/magic-link/signup', {
      signup_token: next.signup_token,
      date_of_birth: childDob,
      guardian_email: guardianEmail,
    });
    expect(signup.status).toBe(201);
    return finish(signup);
  }

  async function approveChild(guardianEmail: string): Promise<void> {
    const job = await emails.nextJob(guardianEmail, 'parental_consent');
    const token = new URL(String(job.variables['approve_link'])).searchParams.get('token') ?? '';
    secrets.push(token);
    const approved = await post('/api/v1/auth/parental-consent/approve', {
      token,
      date_of_birth: '1980-01-01',
    });
    expect(approved.status).toBe(204);
  }

  async function openFamilySession(email: string): Promise<string> {
    const start = await post('/api/v1/auth/family/magic-link', { email });
    expect(start.status).toBe(202);
    const job = await emails.nextJob(email, 'family_access');
    const token = new URL(String(job.variables['link'])).searchParams.get('token') ?? '';
    secrets.push(token);
    const opened = await post('/api/v1/auth/family/session', { token });
    expect(opened.status).toBe(200);
    const familyToken = opened.headers.get(FAMILY_TOKEN_HEADER) ?? '';
    secrets.push(familyToken);
    return familyToken;
  }

  function asFamily(token: string): RequestInit {
    return { headers: { [FAMILY_TOKEN_HEADER]: token } };
  }

  it('does not say whether a family magic link was sent', async () => {
    const unknown = await post('/api/v1/auth/family/magic-link', {
      email: 'not-a-guardian@example.com',
    });
    expect(unknown.status).toBe(202);
    expect(await unknown.text()).toBe('');
  });

  it('lets a guardian manage controls, sessions, username changes and another guardian', async () => {
    const child = await signUpChild('family-child@example.com', 'family-parent@example.com');
    await approveChild('family-parent@example.com');
    const familyToken = await openFamilySession('family-parent@example.com');

    const listed = await call('/api/v1/family', asFamily(familyToken));
    expect(listed.status).toBe(200);
    const children = (await listed.json()) as { children: { id: string }[] };
    expect(children.children.map((row) => row.id)).toEqual([child.userId]);

    const patched = await call(`/api/v1/family/${child.userId}/controls`, {
      method: 'PATCH',
      body: JSON.stringify({ online_play: true, public_profile: true }),
      ...asFamily(familyToken),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      online_play: true,
      in_game_chat: false,
      public_profile: true,
      leaderboard_visible: false,
    });

    const firstName = await post(
      '/api/v1/me/username',
      { username: 'ChildOne' },
      signedInAs(child.userId, child.sessionId),
    );
    expect(firstName.status).toBe(200);
    const change = await post(
      '/api/v1/me/username',
      { username: 'ChildTwo' },
      signedInAs(child.userId, child.sessionId),
    );
    expect(change.status).toBe(202);
    expect(await change.json()).toMatchObject({
      username: 'ChildTwo',
      status: 'pending_guardian_approval',
    });
    await emails.nextJob('family-parent@example.com', 'guardian_username_change');

    const detail = await call(`/api/v1/family/${child.userId}`, asFamily(familyToken));
    const body = (await detail.json()) as {
      pending_username_change: { id: string; username: string };
      pending_app_approvals: unknown[];
    };
    expect(body.pending_username_change.username).toBe('ChildTwo');
    expect(body.pending_app_approvals).toEqual([]);
    await identity.context.db
      .updateTable('users')
      .set({ username_updated_at: new Date(Date.now() - 31 * 86_400_000) })
      .where('id', '=', child.userId)
      .execute();
    const approvedName = await call(
      `/api/v1/family/${child.userId}/username-changes/${body.pending_username_change.id}/approve`,
      { method: 'POST', ...asFamily(familyToken) },
    );
    expect(approvedName.status).toBe(200);
    expect(await approvedName.json()).toEqual({ username: 'ChildTwo' });

    const sessions = await call(`/api/v1/family/${child.userId}/sessions`, asFamily(familyToken));
    expect(sessions.status).toBe(200);
    const sessionList = (await sessions.json()) as { items: { id: string }[] };
    expect(sessionList.items.length).toBeGreaterThan(0);
    const revoked = await call(
      `/api/v1/family/${child.userId}/sessions/${sessionList.items[0]?.id ?? ''}`,
      { method: 'DELETE', ...asFamily(familyToken) },
    );
    expect(revoked.status).toBe(204);

    const invited = await call(`/api/v1/family/${child.userId}/guardians`, {
      method: 'POST',
      body: JSON.stringify({ email: 'family-parent-2@example.com' }),
      ...asFamily(familyToken),
    });
    expect(invited.status).toBe(202);
    const inviteJob = await emails.nextJob('family-parent-2@example.com', 'family_invite');
    const inviteToken =
      new URL(String(inviteJob.variables['link'])).searchParams.get('token') ?? '';
    secrets.push(inviteToken);
    const accepted = await post('/api/v1/auth/family/invite/accept', {
      token: inviteToken,
      date_of_birth: '1979-02-02',
    });
    expect(accepted.status).toBe(204);
    const over = await call(`/api/v1/family/${child.userId}/guardians`, {
      method: 'POST',
      body: JSON.stringify({ email: 'family-parent-3@example.com' }),
      ...asFamily(familyToken),
    });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ code: 'GUARDIAN_LIMIT' });

    const activity = await call(`/api/v1/family/${child.userId}/activity`, asFamily(familyToken));
    expect(await activity.json()).toMatchObject({
      sign_ins: expect.any(Number) as unknown,
      games: [],
      connected_apps: [],
    });

    const adult = await signUp('family-parent@example.com');
    const linked = await call('/api/v1/family', {
      as: signedInAs(adult.userId, adult.sessionId),
    });
    expect(linked.status).toBe(200);
    expect(((await linked.json()) as { children: { id: string }[] }).children[0]?.id).toBe(
      child.userId,
    );
    const me = await call('/api/v1/me', { as: signedInAs(adult.userId, adult.sessionId) });
    expect(await me.json()).toMatchObject({
      family: { children: [{ id: child.userId, username: 'ChildTwo' }] },
    });

    await publishCronTick(gateway.js, ACTIVITY_SUMMARY_JOB, new Date());
    await emails.nextJob('family-parent@example.com', 'guardian_activity');
    await emails.nextJob('family-parent-2@example.com', 'guardian_activity');
  });
});

describe('graduation', () => {
  const childDob = `${String(new Date().getUTCFullYear() - 10)}-01-01`;

  function yearsAgo(years: number, extraDays = 0): string {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() - extraDays),
    )
      .toISOString()
      .slice(0, 10);
  }

  async function signUpChild(email: string, guardianEmail: string): Promise<SignedIn> {
    const verify = await post('/api/v1/auth/magic-link/verify', { token: await linkToken(email) });
    const next = (await verify.json()) as { signup_token: string };
    secrets.push(next.signup_token);
    const signup = await post('/api/v1/auth/magic-link/signup', {
      signup_token: next.signup_token,
      date_of_birth: childDob,
      guardian_email: guardianEmail,
    });
    expect(signup.status).toBe(201);
    return finish(signup);
  }

  async function approveChild(guardianEmail: string): Promise<void> {
    const job = await emails.nextJob(guardianEmail, 'parental_consent');
    const token = new URL(String(job.variables['approve_link'])).searchParams.get('token') ?? '';
    secrets.push(token);
    const approved = await post('/api/v1/auth/parental-consent/approve', {
      token,
      date_of_birth: '1980-01-01',
    });
    expect(approved.status).toBe(204);
  }

  async function setDateOfBirth(userId: string, dateOfBirth: string): Promise<void> {
    await identity.context.db
      .updateTable('users')
      .set({ date_of_birth: dateOfBirth })
      .where('id', '=', userId)
      .execute();
  }

  it('notifies the child and guardian at consent_age, and keeps the link during the grace period', async () => {
    const child = await signUpChild('grad-child@example.com', 'grad-parent@example.com');
    await approveChild('grad-parent@example.com');
    await setDateOfBirth(child.userId, yearsAgo(13));
    await publishCronTick(gateway.js, GRADUATION_JOB, new Date());
    await emails.nextJob('grad-child@example.com', 'graduation');
    await emails.nextJob('grad-parent@example.com', 'guardian_graduation');
    await publishCronTick(gateway.js, GRADUATION_JOB, new Date());
    const asChild = signedInAs(child.userId, child.sessionId);
    const me = await call('/api/v1/me', { as: asChild });
    expect(await me.json()).toMatchObject({
      family: { pending_removal: null, grace_ends_at: expect.any(String) as unknown },
    });
    const refused = await post('/api/v1/me/family/removal', {}, asChild);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'GUARDIAN_REMOVAL_NOT_ALLOWED' });
  });

  it('lets a 14-year-old request removal only with guardian approval', async () => {
    const child = await signUpChild('teen-child@example.com', 'teen-parent@example.com');
    await approveChild('teen-parent@example.com');
    await setDateOfBirth(child.userId, yearsAgo(14));
    const asChild = signedInAs(child.userId, child.sessionId);
    const requested = await post('/api/v1/me/family/removal', {}, asChild);
    expect(requested.status).toBe(202);
    expect(await requested.json()).toMatchObject({ status: 'pending_guardian_approval' });
    await emails.nextJob('teen-parent@example.com', 'guardian_removal_request');
    const again = await post('/api/v1/me/family/removal', {}, asChild);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'GUARDIAN_REMOVAL_PENDING' });

    const start = await post('/api/v1/auth/family/magic-link', {
      email: 'teen-parent@example.com',
    });
    expect(start.status).toBe(202);
    const access = await emails.nextJob('teen-parent@example.com', 'family_access');
    const token = new URL(String(access.variables['link'])).searchParams.get('token') ?? '';
    secrets.push(token);
    const opened = await post('/api/v1/auth/family/session', { token });
    const familyToken = opened.headers.get(FAMILY_TOKEN_HEADER) ?? '';
    secrets.push(familyToken);
    const detail = await call(`/api/v1/family/${child.userId}`, {
      headers: { [FAMILY_TOKEN_HEADER]: familyToken },
    });
    expect(await detail.json()).toMatchObject({
      pending_removal: { requested_at: expect.any(String) as unknown },
    });
    const approved = await call(`/api/v1/family/${child.userId}/removal/approve`, {
      method: 'POST',
      headers: { [FAMILY_TOKEN_HEADER]: familyToken },
    });
    expect(approved.status).toBe(204);
    await emails.nextJob('teen-parent@example.com', 'guardian_removed');
    const listed = await call('/api/v1/family', {
      headers: { [FAMILY_TOKEN_HEADER]: familyToken },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ children: [] });
    const me = await call('/api/v1/me', { as: asChild });
    expect(await me.json()).toMatchObject({ family: { guardians: [], pending_removal: null } });
  });

  it('lets an 18-year-old remove the link without approval', async () => {
    const child = await signUpChild('adult-child@example.com', 'adult-parent@example.com');
    await approveChild('adult-parent@example.com');
    await setDateOfBirth(child.userId, yearsAgo(18));
    const removed = await post(
      '/api/v1/me/family/removal',
      {},
      signedInAs(child.userId, child.sessionId),
    );
    expect(removed.status).toBe(204);
    await emails.nextJob('adult-parent@example.com', 'guardian_removed');
    const me = await call('/api/v1/me', { as: signedInAs(child.userId, child.sessionId) });
    expect(await me.json()).toMatchObject({ family: { guardians: [], pending_removal: null } });
  });

  it('reminds guardians while a removal request is pending', async () => {
    const child = await signUpChild('remind-child@example.com', 'remind-parent@example.com');
    await approveChild('remind-parent@example.com');
    await setDateOfBirth(child.userId, yearsAgo(14));
    const requested = await post(
      '/api/v1/me/family/removal',
      {},
      signedInAs(child.userId, child.sessionId),
    );
    expect(requested.status).toBe(202);
    await emails.nextJob('remind-parent@example.com', 'guardian_removal_request');
    await identity.context.db
      .updateTable('guardian_removal_requests')
      .set({ last_reminded_at: new Date(Date.now() - 8 * 86_400_000) })
      .where('user_id', '=', child.userId)
      .execute();
    await publishCronTick(gateway.js, REMOVAL_REMINDERS_JOB, new Date());
    await emails.nextJob('remind-parent@example.com', 'guardian_removal_request');
  });
});

describe('log scrubbing', () => {
  it('keeps tokens, addresses and dates of birth out of the logs', () => {
    expect(logs.lines.length).toBeGreaterThan(0);
    assertLogsScrubbed(logs.lines, [
      ...secrets,
      ...secrets.map((secret) => hashToken(secret)),
      'rights@example.com',
      'pwd-new@example.com',
      'child@example.com',
      'parent@example.com',
      'consent-child@example.com',
      'consent-parent@example.com',
      'consent-parent-2@example.com',
      'consent-parent-3@example.com',
      'consent-parent-4@example.com',
      'consent-parent-5@example.com',
      'decline-child@example.com',
      'decline-parent@example.com',
      'expire-child@example.com',
      'expire-parent@example.com',
      'pwd-child@example.com',
      'pwd-parent@example.com',
      'not-a-guardian@example.com',
      'family-child@example.com',
      'family-parent@example.com',
      'family-parent-2@example.com',
      'family-parent-3@example.com',
      'grad-child@example.com',
      'grad-parent@example.com',
      'teen-child@example.com',
      'teen-parent@example.com',
      'adult-child@example.com',
      'adult-parent@example.com',
      'remind-child@example.com',
      'remind-parent@example.com',
      '1985-07-04',
      PASSWORD,
      postgres.getPassword(),
    ]);
  });
});
