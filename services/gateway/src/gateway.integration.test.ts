import { randomBytes } from 'node:crypto';

import { Kvm } from '@nats-io/kv';
import { type Bus, connectBus, createEvent, rpcRequest, serveRpc } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import {
  createServiceRouter,
  defineService,
  IDENTITY_HEADER,
  IDENTITY_KEYS_METHOD,
  type JsonWebKeySet,
  type RunningService,
  type ServiceContext,
  serviceSchema,
  startService,
} from '@qtiauth/service-kit';
import { natsUrl, startNats, startValkey } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { KEYS_BUCKET, KEYS_ENTRY, keySetSchema } from './identity-keys.ts';
import { definition } from './service.ts';
import { hashToken, type ResolvedSession, type ResolveSessionRequest } from './sessions.ts';
import { gatewayService, type RunningGateway } from './start.ts';

const TOKEN = randomBytes(32).toString('base64url');
const USER_ID = '0199a0e0-0000-7000-8000-00000000abcd';
const ENCRYPTION_KEY = randomBytes(32).toString('base64');

const notes = defineService({ name: 'notes', version: '1.0.0', module: 'core' });
const notesRouter = createServiceRouter<ServiceContext<typeof notes>>(notes);
notesRouter.route({
  method: 'GET',
  path: '/api/v1/notes/whoami',
  operation_id: 'whoami',
  summary: 'Who is calling',
  auth: 'session',
  rate_limit: 'notes',
  responses: {
    200: {
      description: 'The caller',
      schema: z.object({ sub: z.string().nullable(), forwarded_for: z.string().nullable() }),
    },
  },
  handler: ({ identity, request }) =>
    Promise.resolve({
      status: 200 as const,
      body: { sub: identity.sub, forwarded_for: request.headers.get('x-forwarded-for') },
    }),
});
notesRouter.route({
  method: 'GET',
  path: '/api/v1/notes/me',
  operation_id: 'me',
  summary: 'The caller, without a tight rate limit',
  auth: 'session',
  rate_limit: 'global',
  responses: { 204: { description: 'Signed in' } },
  handler: () => Promise.resolve({ status: 204 as const }),
});
notesRouter.route({
  method: 'GET',
  path: '/api/v1/notes/ping',
  operation_id: 'ping',
  summary: 'Ping',
  auth: 'none',
  rate_limit: 'global',
  responses: { 204: { description: 'Pong' } },
  handler: () => Promise.resolve({ status: 204 as const }),
});

let nats: Awaited<ReturnType<typeof startNats>>;
let valkey: Awaited<ReturnType<typeof startValkey>>;
let identityBus: Bus;
let notesService: RunningService<typeof notes>;
let gatewayRunning: RunningService<typeof definition>;
let gateway: RunningGateway;
let resolvedSession: ResolvedSession | null;
const logs = captureLogs();

function busConfig() {
  return sections.bus.parse({ servers: [natsUrl(nats)] });
}

function session(): ResolvedSession {
  return {
    session_id: 'session-1',
    user_id: USER_ID,
    account_state: 'active',
    permissions: [],
    restrictions: [],
    age_band: 'adult',
    parental_controls: null,
    amr: ['email'],
    acr: 'aal1',
    step_up_at: null,
    legal_acceptance_required: false,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

function url(path: string): string {
  return `http://localhost:${String(gateway.ports[0])}${path}`;
}

const signedIn = { cookie: `__Host-qtiauth_session=${TOKEN}` };

beforeAll(async () => {
  [nats, valkey] = await Promise.all([startNats(), startValkey()]);

  identityBus = await connectBus(busConfig(), 'identity');
  resolvedSession = session();
  serveRpc<ResolveSessionRequest, { session: ResolvedSession | null }>(identityBus, {
    method: 'resolve_session',
    handler: (request) =>
      Promise.resolve({
        session: request.binding_token_hash === hashToken(TOKEN) ? resolvedSession : null,
      }),
    onError: () => undefined,
  });

  notesService = await startService(notes, {
    router: notesRouter,
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    config: {
      service: sections.service.parse({}),
      observability: sections.observability.parse({ metrics: { process_metrics: false } }),
      bus: busConfig(),
      database: sections.database.parse({}),
      migrations: sections.migrations.parse({}),
    },
  });
  const service = gatewayService({ hostPort: 0 });
  gatewayRunning = await startService(definition, {
    ...service.options,
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    config: serviceSchema(definition).parse({
      bus: { servers: [natsUrl(nats)] },
      valkey: { host: valkey.getHost(), port: valkey.getPort() },
      observability: {
        logs: { user_id_hash_key: 'integration' },
        metrics: { process_metrics: false },
      },
      features: {
        games: { licensing: { enabled: true } },
      },
      gateway: {
        identity_keys: { encryption_key: ENCRYPTION_KEY },
        discovery: { interval: '500ms', expiry: '2s', startup_grace: '1ms' },
        session_cache: { ttl: '1m' },
        upstreams: { notes: notesService.url },
      },
      rate_limits: { notes: { per: 'user', limit: 3, window: '1m' } },
    }),
  });
  gateway = service.gateway();

  await vi.waitFor(
    () => {
      expect(gateway.registry.isRunning('notes')).toBe(true);
    },
    { timeout: 10_000 },
  );
});

afterAll(async () => {
  await notesService.stop();
  await gatewayRunning.stop();
  await identityBus.close();
  await Promise.all([nats.stop(), valkey.stop()]);
});

describe('gateway end to end', () => {
  it('rejects a request that reaches a service without an identity token', async () => {
    const direct = await fetch(`${notesService.url}/api/v1/notes/ping`);
    expect(direct.status).toBe(401);
    expect(await direct.json()).toMatchObject({ code: 'IDENTITY_TOKEN_INVALID' });

    const forged = await fetch(`${notesService.url}/api/v1/notes/ping`, {
      headers: { [IDENTITY_HEADER]: 'a.b.c' },
    });
    expect(forged.status).toBe(401);
  });

  it('routes announced services, resolving the session through identity', async () => {
    expect((await fetch(url('/api/v1/notes/ping'))).status).toBe(204);

    const response = await fetch(url('/api/v1/notes/whoami'), { headers: signedIn });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sub: USER_ID,
      forwarded_for: expect.stringMatching(/^(?:127\.0\.0\.1|::1)$/) as unknown,
    });
    expect(response.headers.get('ratelimit-limit')).toBe('3');

    expect((await fetch(url('/api/v1/notes/whoami'))).status).toBe(401);
  });

  it('rate-limits in Valkey across requests', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (await fetch(url('/support/api/v1/notes/whoami'), { headers: signedIn })).status,
      );
    }
    expect(statuses).toContain(429);
    const keys = await gateway.valkey.keys('qtiauth:ratelimit:*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join()).not.toContain(USER_ID);
  });

  it('stores signing keys encrypted in NATS and keeps services working across a rotation', async () => {
    const kv = await new Kvm(identityBus.js).open(KEYS_BUCKET);
    const stored = keySetSchema.parse((await kv.get(KEYS_ENTRY))?.json());
    expect(stored.keys[0]?.private_key.alg).toBe('A256GCM');

    const before = gateway.keyring.signingKey().kid;
    await gateway.keyring.rotate();
    const jwks = await rpcRequest<JsonWebKeySet>(identityBus, 'gateway', IDENTITY_KEYS_METHOD, {});
    expect(jwks.status === 'ok' && jwks.data.keys.map((key) => key.kid)).toEqual([
      gateway.keyring.signingKey().kid,
      before,
    ]);
    await vi.waitFor(async () => {
      expect((await fetch(url('/api/v1/notes/ping'))).status).toBe(204);
    });
  });

  it('drops a cached session when identity publishes a revocation', async () => {
    expect((await fetch(url('/api/v1/notes/me'), { headers: signedIn })).status).toBe(204);
    resolvedSession = null;
    expect((await fetch(url('/api/v1/notes/me'), { headers: signedIn })).status).toBe(204);

    const event = createEvent({
      type: 'qtiauth.identity.session.revoked.v1',
      actor: { type: 'user', id: USER_ID },
      subject: { type: 'user', id: USER_ID },
      data: { session_id: 'session-1' },
    });
    await identityBus.js.publish(event.type, JSON.stringify(event), { msgID: event.event_id });
    await vi.waitFor(
      async () => {
        const response = await fetch(url('/api/v1/notes/me'), { headers: signedIn });
        expect(response.status).toBe(401);
        expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
      },
      { timeout: 10_000 },
    );
    resolvedSession = session();
  });

  it('merges OpenAPI and reports features and health', async () => {
    const openapi = (await (await fetch(url('/api/v1/openapi.json'))).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(openapi.paths)).toEqual(
      expect.arrayContaining(['/v1/notes/whoami', '/v1/meta/health', '/v1/openapi.json']),
    );

    const health = (await (await fetch(url('/api/v1/meta/health'))).json()) as {
      status: string;
      problems: { code: string; feature?: string }[];
    };
    expect(health.status).toBe('degraded');
    expect(health.problems).toContainEqual({
      code: 'FEATURE_SERVICE_NOT_RUNNING',
      feature: 'features.games.licensing.enabled',
      service: 'games',
    });
  });

  it('forgets a service that stops, so its routes stop existing', async () => {
    await notesService.stop();
    await vi.waitFor(
      async () => {
        expect((await fetch(url('/api/v1/notes/ping'))).status).toBe(404);
      },
      { timeout: 10_000 },
    );
  });

  it('keeps tokens and user IDs out of the logs', () => {
    assertLogsScrubbed(logs.lines, [TOKEN, hashToken(TOKEN), USER_ID, ENCRYPTION_KEY]);
  });
});
