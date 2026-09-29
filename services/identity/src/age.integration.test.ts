import { randomUUIDv7 } from 'node:crypto';

import { type Bus, connectBus, publishCronTick, rpcRequest } from '@qtiauth/bus';
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AGE_RECOMPUTE_JOB } from './age-bands.ts';
import type { Database } from './database.ts';
import { definition } from './service.ts';
import { identityService } from './start.ts';
import { type CapturedEmails, captureEmails } from './testing.ts';

const HOST = 'me.example.com';
const key = generateIdentityKey();
const STAFF_ID = '11111111-1111-4111-8111-111111111111';

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

const staff: Partial<Identity> = {
  auth: 'session',
  sub: STAFF_ID,
  sid: '22222222-2222-4222-8222-222222222222',
  amr: ['email'],
  acr: 'aal2',
  permissions: ['users.edit_dob'],
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
    session: { session_id: string; age_band: string } | null;
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

async function insertUser(options: {
  email: string;
  dateOfBirth: string;
  publicProfile?: boolean;
  leaderboardVisible?: boolean;
}): Promise<string> {
  const id = randomUUIDv7();
  await identity.context.db
    .insertInto('users')
    .values({
      id,
      state: 'active',
      email: options.email,
      email_normalized: options.email,
      email_verified_at: new Date(),
      date_of_birth: options.dateOfBirth,
      locale: null,
      public_profile: options.publicProfile ?? true,
      leaderboard_visible: options.leaderboardVisible ?? true,
      security_notifications: true,
    })
    .execute();
  return id;
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
      session_security: { new_device_email: false },
      security: { encryption_key: Buffer.alloc(32, 9).toString('base64') },
      age: { assurance: { required_for: ['claim_adult_band'] } },
    }),
  });
});

afterAll(async () => {
  await identity.stop();
  await emails.stop();
  await Promise.all([gateway.close(), notifier.close()]);
  await Promise.all([postgres.stop(), nats.stop(), valkey.stop()]);
});

describe('age bands', () => {
  it('sets under-18 privacy defaults at signup, and adult defaults the other way', async () => {
    const teen = await signUp('teen@example.com', '2010-01-01');
    const adult = await signUp('grown@example.com', '1990-01-01');
    expect(await (await call('/api/v1/me', { as: asUser(teen) })).json()).toMatchObject({
      age_band: '16_to_17',
      public_profile: false,
      leaderboard_visible: false,
    });
    expect(await (await call('/api/v1/me', { as: asUser(adult) })).json()).toMatchObject({
      age_band: 'adult',
      public_profile: true,
      leaderboard_visible: true,
    });
  });

  it('records self_declared assurance at signup, and claim_adult_band when required', async () => {
    const adult = await signUp('assure-adult@example.com', '1988-04-02');
    const teen = await signUp('assure-teen@example.com', '2010-04-02');
    const exported = await rpcRequest<UserExport>(gateway, 'identity', EXPORT_USER_METHOD, {
      user_id: adult.userId,
    });
    expect(exported).toMatchObject({
      status: 'ok',
      data: {
        data: {
          age_assurance: [
            { provider: 'self_declared', strength: 'self_declared', trigger: 'signup' },
            { provider: 'self_declared', strength: 'self_declared', trigger: 'claim_adult_band' },
          ],
        },
      },
    });
    const teenExport = await rpcRequest<UserExport>(gateway, 'identity', EXPORT_USER_METHOD, {
      user_id: teen.userId,
    });
    expect(teenExport).toMatchObject({
      status: 'ok',
      data: {
        data: {
          age_assurance: [
            { provider: 'self_declared', strength: 'self_declared', trigger: 'signup' },
          ],
        },
      },
    });
  });

  it('emits age_band_changed when a user turns 18 overnight, without them signing in', async () => {
    const birthday = new Date('2026-09-17T00:05:00Z');
    const userId = await insertUser({ email: 'eighteen@example.com', dateOfBirth: '2008-09-17' });
    await publishCronTick(gateway.js, AGE_RECOMPUTE_JOB, birthday);

    await vi.waitFor(async () => {
      const events = await checkOutboxContract(identity.context.db, await loadEventCatalog());
      expect(events).toContainEqual(
        expect.objectContaining({
          type: IDENTITY_EVENTS.userAgeBandChanged,
          subject: { type: 'user', id: userId },
          data: { previous_age_band: '16_to_17', age_band: 'adult' },
        }),
      );
    });
  });

  it('treats a 29 February birthday as 1 March in non-leap years', async () => {
    const userId = await insertUser({ email: 'leap@example.com', dateOfBirth: '2008-02-29' });
    await publishCronTick(gateway.js, AGE_RECOMPUTE_JOB, new Date('2026-03-01T00:05:00Z'));
    await vi.waitFor(async () => {
      const events = await checkOutboxContract(identity.context.db, await loadEventCatalog());
      expect(events).toContainEqual(
        expect.objectContaining({
          type: IDENTITY_EVENTS.userAgeBandChanged,
          subject: { type: 'user', id: userId },
          data: { previous_age_band: '16_to_17', age_band: 'adult' },
        }),
      );
    });
  });
});

describe('staff date-of-birth edits', () => {
  it('changes the date of birth with a reason, and applies under-18 defaults', async () => {
    const user = await signUp('edit-dob@example.com', '1990-01-01');
    const edited = await post(
      `/api/v1/admin/users/${user.userId}/date-of-birth`,
      { date_of_birth: '2010-06-01', reason: 'Corrected from documents' },
      staff,
    );
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({
      date_of_birth: '2010-06-01',
      age_band: '16_to_17',
    });
    expect(await (await call('/api/v1/me', { as: asUser(user) })).json()).toMatchObject({
      age_band: '16_to_17',
      public_profile: false,
      leaderboard_visible: false,
    });

    const exported = await rpcRequest<UserExport>(gateway, 'identity', EXPORT_USER_METHOD, {
      user_id: user.userId,
    });
    expect(exported).toMatchObject({
      status: 'ok',
      data: {
        data: {
          account: { date_of_birth: '2010-06-01' },
          date_of_birth_changes: [
            {
              reason: 'Corrected from documents',
              previous_date_of_birth: '1990-01-01',
              date_of_birth: '2010-06-01',
            },
          ],
        },
      },
    });

    const events = await checkOutboxContract(identity.context.db, await loadEventCatalog());
    expect(events).toContainEqual(
      expect.objectContaining({
        type: IDENTITY_EVENTS.userUpdated,
        actor: { type: 'user', id: STAFF_ID },
        data: { fields: ['date_of_birth'] },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: IDENTITY_EVENTS.userAgeBandChanged,
        actor: { type: 'user', id: STAFF_ID },
        subject: { type: 'user', id: user.userId },
        data: { previous_age_band: 'adult', age_band: '16_to_17' },
      }),
    );
  });

  it('refuses an unchanged date, and refuses without users.edit_dob', async () => {
    const user = await signUp('same-dob@example.com', '1991-02-03');
    expect(
      await (
        await post(
          `/api/v1/admin/users/${user.userId}/date-of-birth`,
          { date_of_birth: '1991-02-03', reason: 'No change' },
          staff,
        )
      ).json(),
    ).toMatchObject({ code: 'DATE_OF_BIRTH_UNCHANGED' });
    expect(
      (
        await post(
          `/api/v1/admin/users/${user.userId}/date-of-birth`,
          { date_of_birth: '1992-02-03', reason: 'Nope' },
          { ...staff, permissions: [] },
        )
      ).status,
    ).toBe(403);
  });
});

describe('under-18 security notifications', () => {
  it('emails a new device even when session_security.new_device_email is off', async () => {
    await signUp('teen-device@example.com', '2010-01-01');
    await emails.nextJob('teen-device@example.com', 'new_device');
  });
});
