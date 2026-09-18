import { type Bus, connectBus, consumeWork, publishCronTick, rpcRequest } from '@qtiauth/bus';
import { checkOutboxContract } from '@qtiauth/bus/testing';
import { sections } from '@qtiauth/config';
import { type EmailJob, emailQueue } from '@qtiauth/email';
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

import type { Database } from './database.ts';
import { LEGAL_PUBLISH_JOB, syncLegalDocuments } from './legal.ts';
import { hashLegalBody, LegalDocumentsError } from './legal-documents.ts';
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
const notices: EmailJob[] = [];
let noticeConsumer: Awaited<ReturnType<typeof consumeWork<EmailJob>>>;
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
    session: { session_id: string; legal_acceptance_required: boolean } | null;
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

function asUser(user: SignedIn): Partial<Identity> {
  return signedInAs(user.userId, user.sessionId);
}

async function insertVersion(row: {
  id: string;
  version: string;
  effectiveAt?: Date;
  material: boolean;
  summary: string;
  body?: string;
}): Promise<void> {
  const body = row.body ?? `${row.id} ${row.version}`;
  await identity.context.db
    .insertInto('legal_versions')
    .values({
      id: row.id,
      version: row.version,
      effective_at: row.effectiveAt ?? new Date(),
      material: row.material,
      summary: row.summary,
      body,
      body_hash: hashLegalBody(body),
      published_at: null,
    })
    .execute();
}

async function publishNow(): Promise<void> {
  await publishCronTick(gateway.js, LEGAL_PUBLISH_JOB, new Date());
  await vi.waitFor(async () => {
    const unpublished = await identity.context.db
      .selectFrom('legal_versions')
      .select('version')
      .where('published_at', 'is', null)
      .where('effective_at', '<=', new Date())
      .execute();
    expect(unpublished).toEqual([]);
  });
}

beforeAll(async () => {
  [postgres, nats, valkey] = await Promise.all([startPostgres(), startNats(), startValkey()]);
  const bus = sections.bus.parse({ servers: [natsUrl(nats)] });
  gateway = await connectBus(bus, 'gateway');
  notifier = await connectBus(bus, 'notifier');
  serveTestIdentityKeys(gateway, key);
  emails = await captureEmails(notifier);
  noticeConsumer = await consumeWork<EmailJob>(notifier, {
    queue: emailQueue('normal'),
    handler: (message) => {
      notices.push(message.data);
      return Promise.resolve();
    },
    onError: () => undefined,
  });
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
      legal: { public_history: false },
    }),
  });
});

afterAll(async () => {
  await identity.stop();
  await noticeConsumer.stop();
  await emails.stop();
  await Promise.all([gateway.close(), notifier.close()]);
  await Promise.all([postgres.stop(), nats.stop(), valkey.stop()]);
});

describe('legal documents', () => {
  it('lists current documents, interpolates brand, and hides previous versions', async () => {
    const listed = await call('/api/v1/legal');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      documents: expect.arrayContaining([
        expect.objectContaining({
          id: 'terms',
          version: '2020-01-01',
          material: true,
          summary: 'The terms of service for Example Account.',
        }),
        expect.objectContaining({ id: 'privacy', material: true }),
        expect.objectContaining({ id: 'children-summary', material: false }),
      ]) as unknown,
    });

    const current = await call('/api/v1/legal/terms');
    expect(current.status).toBe(200);
    const body = (await current.json()) as { body: string };
    expect(body.body).toContain('Example Account');
    expect(body.body).not.toContain('{{ brand.product_name }}');

    await insertVersion({
      id: 'terms',
      version: '2019-01-01',
      effectiveAt: new Date('2019-01-01T00:00:00Z'),
      material: true,
      summary: 'An older version.',
    });
    const previous = await call('/api/v1/legal/terms/2019-01-01');
    expect(await previous.json()).toMatchObject({ code: 'LEGAL_DOCUMENT_NOT_FOUND' });
    expect((await call('/api/v1/legal/terms/2020-01-01')).status).toBe(200);

    const page = await call('/legal/terms');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Example Account');
  });

  it('records signup acceptance so a new account is not gated', async () => {
    const user = await signUp('legal-signup@example.com');
    expect(await resolve(user.token)).toMatchObject({ legal_acceptance_required: false });
    const mine = await call('/api/v1/me/legal', { as: asUser(user) });
    expect(await mine.json()).toMatchObject({
      pending: [],
      accepted: expect.arrayContaining([
        expect.objectContaining({ id: 'terms', version: '2020-01-01', method: 'signup' }),
        expect.objectContaining({ id: 'privacy', method: 'signup' }),
        expect.objectContaining({ id: 'children-summary', method: 'signup' }),
      ]) as unknown,
    });
  });

  it('rejects a changed body without a version bump', async () => {
    await expect(
      syncLegalDocuments(identity.context.db, [
        {
          file: 'terms.md',
          id: 'terms',
          version: '2020-01-01',
          effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
          material: true,
          summary: 'changed',
          body: 'changed body',
          bodyHash: hashLegalBody('changed body'),
        },
      ]),
    ).rejects.toThrow(LegalDocumentsError);
  });

  it('requires re-acceptance of a new material version, then lifts the gate', async () => {
    const user = await signUp('legal-accept@example.com');
    await insertVersion({
      id: 'terms',
      version: '2026-10-01',
      material: true,
      summary: 'We added passkeys.',
    });
    await publishNow();

    const pending = await call('/api/v1/me/legal', { as: asUser(user) });
    expect(await pending.json()).toMatchObject({
      pending: [expect.objectContaining({ id: 'terms', version: '2026-10-01' })],
    });
    expect(await resolve(user.token)).toMatchObject({ legal_acceptance_required: true });

    await vi.waitFor(async () => {
      const metrics = await (await fetch(`${identity.url}/metrics`)).text();
      expect(metrics).toMatch(/qtiauth_legal_acceptance_pending\{service="identity"\} [1-9]/);
    });

    expect(
      await (
        await post(
          '/api/v1/me/legal/accept',
          { documents: [{ id: 'terms', version: 'missing' }] },
          asUser(user),
        )
      ).json(),
    ).toMatchObject({ code: 'LEGAL_DOCUMENT_NOT_FOUND' });

    const accepted = await post(
      '/api/v1/me/legal/accept',
      { documents: [{ id: 'terms', version: '2026-10-01' }] },
      asUser(user),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ pending: [] });
    expect(await resolve(user.token)).toMatchObject({ legal_acceptance_required: false });

    await vi.waitFor(async () => {
      const events = await checkOutboxContract(identity.context.db, await loadEventCatalog());
      expect(events.map((event) => event.type)).toContain(IDENTITY_EVENTS.userUpdated);
    });
  });

  it('accepts pending documents from the HTML form', async () => {
    const user = await signUp('legal-html@example.com');
    await insertVersion({
      id: 'privacy',
      version: '2026-11-01',
      material: true,
      summary: 'We shortened retention.',
    });
    await publishNow();

    const form = await call('/legal/accept', { as: asUser(user) });
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('action="accept"');

    const submitted = await call('/legal/accept', {
      method: 'POST',
      as: asUser(user),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(submitted.status).toBe(200);
    expect(await submitted.text()).toContain('You have accepted the updated documents.');
    expect(await resolve(user.token)).toMatchObject({ legal_acceptance_required: false });
  });

  it('emails existing accounts when a non-material version takes effect', async () => {
    const user = await signUp('legal-notice@example.com');
    await insertVersion({
      id: 'children-summary',
      version: '2026-12-01',
      material: false,
      summary: 'A clearer summary for people under 18.',
    });
    await publishNow();
    await vi.waitFor(() => {
      expect(
        notices.some(
          (job) =>
            job.template === 'legal_update' &&
            job.to.address === 'legal-notice@example.com' &&
            job.variables['version'] === '2026-12-01',
        ),
      ).toBe(true);
    });
    expect(await resolve(user.token)).toMatchObject({ legal_acceptance_required: false });
  });

  it('exports legal acceptances', async () => {
    const user = await signUp('legal-export@example.com');
    const exported = await rpcRequest<UserExport>(gateway, 'identity', EXPORT_USER_METHOD, {
      user_id: user.userId,
    });
    expect(exported).toMatchObject({
      status: 'ok',
      data: {
        data: {
          legal_acceptances: expect.arrayContaining([
            expect.objectContaining({ document_id: 'terms', method: 'signup' }),
          ]) as unknown,
        },
      },
    });
  });
});
