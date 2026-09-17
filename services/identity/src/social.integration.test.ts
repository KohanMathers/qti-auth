import { type Bus, connectBus, rpcRequest } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import {
  FLOW_BINDING_HEADER,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from './database.ts';
import { LAST_SIGN_IN_METHOD_DETAIL } from './factors.ts';
import { softwarePasskey } from './passkey-testing.ts';
import { definition } from './service.ts';
import { startMockOidc } from './social-testing.ts';
import { identityService } from './start.ts';
import { type CapturedEmails, captureEmails } from './testing.ts';

const HOST = 'me.example.com';
const ORIGIN = `https://${HOST}`;
const key = generateIdentityKey();

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let valkey: Awaited<ReturnType<typeof startValkey>>;
let oidc: Awaited<ReturnType<typeof startMockOidc>>;
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
  return { auth: 'session', sub: userId, sid: sessionId, amr: ['oidc'], acr: 'aal1' };
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

async function finish(response: Response) {
  const body = (await response.json()) as { user_id: string };
  const token = response.headers.get(SESSION_TOKEN_HEADER) ?? '';
  secrets.push(token);
  const session = await resolve(token);
  return { userId: body.user_id, token, sessionId: session?.session_id ?? '', response };
}

async function authorize(start: Response) {
  expect(start.status).toBe(200);
  const binding = start.headers.get(FLOW_BINDING_HEADER) ?? '';
  secrets.push(binding);
  const { url } = (await start.json()) as { url: string };
  const authorized = await fetch(url, { redirect: 'manual' });
  const redirected = new URL(authorized.headers.get('location') ?? '');
  const state = redirected.searchParams.get('state') ?? '';
  secrets.push(state);
  return { binding, state, code: redirected.searchParams.get('code') ?? '', redirected };
}

function complete(
  provider: string,
  flow: { binding: string | null; state: string; code: string },
  as?: Partial<Identity>,
) {
  return call('/api/v1/auth/social/complete', {
    method: 'POST',
    body: JSON.stringify({ provider, state: flow.state, code: flow.code }),
    headers: flow.binding === null ? {} : { [FLOW_BINDING_HEADER]: flow.binding },
    ...(as === undefined ? {} : { as }),
  });
}

async function completeProvider(provider = 'corp') {
  const flow = await authorize(await post(`/api/v1/auth/social/${provider}/start`, {}));
  return complete(provider, flow);
}

async function signUpWithProvider(user: {
  sub: string;
  email: string;
  email_verified: boolean;
  birthdate?: string;
}) {
  oidc.setUser(user);
  const completed = await completeProvider();
  const body = (await completed.json()) as {
    status: string;
    challenge?: string;
    user_id?: string;
  };
  if (body.status === 'signed_in') {
    const token = completed.headers.get(SESSION_TOKEN_HEADER) ?? '';
    secrets.push(token);
    const session = await resolve(token);
    return { userId: body.user_id ?? '', token, sessionId: session?.session_id ?? '' };
  }
  expect(body.status).toBe('signup_required');
  secrets.push(body.challenge ?? '');
  const created = await post('/api/v1/auth/social/signup', {
    challenge: body.challenge,
    date_of_birth: user.birthdate ?? '1990-01-01',
  });
  expect(created.status).toBe(201);
  return finish(created);
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
      valkey: { host: valkey.getHost(), port: valkey.getPort() },
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
      password: {
        argon2: { memory_kib: 8, iterations: 1 },
        breach_check: false,
        failure_delay: { step: '1ms', max: '1ms' },
      },
      captcha: { after: 1000, altcha: { hmac_key: 'integration-captcha-key', max_number: 400 } },
      security: { encryption_key: Buffer.alloc(32, 9).toString('base64') },
      features: {
        auth: {
          magic_link: { enabled: false },
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
});

afterAll(async () => {
  await identity.stop();
  await emails.stop();
  await Promise.all([gateway.close(), notifier.close()]);
  await Promise.all([postgres.stop(), nats.stop(), valkey.stop(), oidc.stop()]);
});

describe('social sign-in', () => {
  it('does not sign in or link to an existing account that happens to use the provider email', async () => {
    const existing = await signUpWithProvider({
      sub: 'first',
      email: 'shared@example.com',
      email_verified: true,
    });
    const other = await signUpWithProvider({
      sub: 'second',
      email: 'shared@example.com',
      email_verified: true,
      birthdate: '1991-02-02',
    });
    expect(other.userId).not.toBe(existing.userId);

    const methods = await call('/api/v1/me/identities', {
      as: signedInAs(existing.userId, existing.sessionId),
    });
    expect(await methods.json()).toMatchObject({
      identities: [{ type: 'oidc:corp' }],
    });
  });

  it('signs in when the same provider subject comes back', async () => {
    const created = await signUpWithProvider({
      sub: 'returning',
      email: 'back@example.com',
      email_verified: true,
      birthdate: '1987-06-06',
    });
    oidc.setUser({
      sub: 'returning',
      email: 'back@example.com',
      email_verified: true,
    });
    const again = await finish(await completeProvider());
    expect(again.userId).toBe(created.userId);
    expect(again.sessionId).not.toBe(created.sessionId);
  });

  it('links only while signed in, and refuses to remove the last sign-in method', async () => {
    const created = await signUpWithProvider({
      sub: 'only-me',
      email: 'solo@example.com',
      email_verified: true,
    });
    const asUser = signedInAs(created.userId, created.sessionId);
    const listed = await call('/api/v1/me/identities', { as: asUser });
    const { identities } = (await listed.json()) as { identities: { id: string }[] };
    const disconnect = await call(`/api/v1/me/identities/${identities[0]?.id ?? ''}`, {
      method: 'DELETE',
      as: asUser,
    });
    expect(disconnect.status).toBe(409);
    expect(await disconnect.json()).toMatchObject({
      code: 'LAST_SIGN_IN_METHOD',
      detail: LAST_SIGN_IN_METHOD_DETAIL,
      delete_account_path: '/account/delete',
    });

    const authenticator = await softwarePasskey(ORIGIN);
    const start = await post('/api/v1/me/passkeys/register/start', {}, asUser);
    const creation = (await start.json()) as {
      challenge: string;
      options: Parameters<typeof authenticator.register>[0];
    };
    secrets.push(creation.challenge);
    const attested = await authenticator.register(creation.options);
    expect(
      (
        await post(
          '/api/v1/me/passkeys/register',
          { challenge: creation.challenge, name: 'Laptop', response: attested },
          asUser,
        )
      ).status,
    ).toBe(201);

    const removed = await call(`/api/v1/me/identities/${identities[0]?.id ?? ''}`, {
      method: 'DELETE',
      as: asUser,
    });
    expect(removed.status).toBe(204);
  });

  it('refuses a callback in a browser that did not start the flow', async () => {
    oidc.setUser({ sub: 'csrf-signin', email: 'csrf-signin@example.com', email_verified: true });
    const missing = await authorize(await post('/api/v1/auth/social/corp/start', {}));
    const withoutBinding = await complete('corp', { ...missing, binding: null });
    expect(withoutBinding.status).toBe(400);
    expect(await withoutBinding.json()).toMatchObject({ code: 'OAUTH_FAILED' });

    const attacker = await authorize(await post('/api/v1/auth/social/corp/start', {}));
    const victim = await authorize(await post('/api/v1/auth/social/corp/start', {}));
    const crossed = await complete('corp', { ...attacker, binding: victim.binding });
    expect(crossed.status).toBe(400);
    expect(crossed.headers.has(SESSION_TOKEN_HEADER)).toBe(false);
  });

  it('links only to the session that started connecting', async () => {
    const owner = await signUpWithProvider({
      sub: 'link-owner',
      email: 'link-owner@example.com',
      email_verified: true,
    });
    const asOwner = signedInAs(owner.userId, owner.sessionId);
    const other = await signUpWithProvider({
      sub: 'link-other',
      email: 'link-other@example.com',
      email_verified: true,
    });

    oidc.setUser({ sub: 'link-victim', email: 'link-victim@example.com', email_verified: true });
    for (const as of [anonymous, { ...anonymous, sid: other.sessionId }]) {
      const stolen = await authorize(await post('/api/v1/me/identities/corp/connect', {}, asOwner));
      const elsewhere = await complete('corp', stolen, as);
      expect(elsewhere.status).toBe(400);
      expect(await elsewhere.json()).toMatchObject({ code: 'OAUTH_FAILED' });
    }

    oidc.setUser({ sub: 'link-owner', email: 'link-owner@example.com', email_verified: true });
    const own = await authorize(await post('/api/v1/me/identities/corp/connect', {}, asOwner));
    const linked = await complete('corp', own, { ...anonymous, sid: owner.sessionId });
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({ status: 'linked', user_id: owner.userId });
  });

  it('only goes back to a path on the account surface after signing in', async () => {
    await signUpWithProvider({
      sub: 'redirected',
      email: 'redirected@example.com',
      email_verified: true,
    });
    const start = await call('/auth/social/corp/start?return_to=//evil.example/login');
    expect(start.status).toBe(302);
    const binding = start.headers.get(FLOW_BINDING_HEADER) ?? '';
    secrets.push(binding);
    const authorized = await fetch(start.headers.get('location') ?? '', { redirect: 'manual' });
    const redirected = new URL(authorized.headers.get('location') ?? '');
    secrets.push(redirected.searchParams.get('state') ?? '');
    const callback = await call(`/auth/social/corp/callback${redirected.search}`, {
      headers: { [FLOW_BINDING_HEADER]: binding },
      redirect: 'manual',
    });
    secrets.push(callback.headers.get(SESSION_TOKEN_HEADER) ?? '');
    expect(callback.headers.get('location')).toBeNull();
    expect(callback.status).toBe(200);
  });

  it('sends our own verification when the provider email is unverified', async () => {
    const created = await signUpWithProvider({
      sub: 'unverified',
      email: 'need-verify@example.com',
      email_verified: false,
    });
    const link = await emails.nextLink('need-verify@example.com');
    expect(link.pathname).toBe('/auth/verify-email');
    secrets.push(link.searchParams.get('token') ?? '');
    const me = await call('/api/v1/me', { as: signedInAs(created.userId, created.sessionId) });
    expect(await me.json()).toMatchObject({
      email_verified: false,
      account_state: 'pending_email_verification',
    });
  });

  it('keeps tokens and addresses out of the logs', () => {
    assertLogsScrubbed(
      logs.lines,
      secrets.filter((secret) => secret !== ''),
    );
  });
});
