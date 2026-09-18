import { randomUUID } from 'node:crypto';

import { type Bus, connectBus, createBusTablesV1, rpcRequest, writeEvent } from '@qtiauth/bus';
import { type QtiauthConfig, sections } from '@qtiauth/config';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import { natsUrl, startNats, startPostgres } from '@qtiauth/testing';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';

import { ANNOUNCE_SUBJECT, DISCOVER_SUBJECT, serviceAnnouncementSchema } from './announce.ts';
import { EXPORT_USER_METHOD, USER_DELETED_EVENT, type UserExport } from './data-rights.ts';
import { IDENTITY_HEADER } from './identity.ts';
import { definePermissions } from './permissions.ts';
import {
  createServiceRouter,
  defineService,
  OPENAPI_METHOD,
  type RunningService,
  type ServiceContext,
  startService,
} from './service.ts';
import { generateIdentityKey, identityHeaders, serveTestIdentityKeys } from './testing.ts';

interface Database {
  notes: { user_id: string; body: string };
}

const definition = defineService({
  name: 'identity',
  version: '0.7.0',
  module: 'core',
  permissions: definePermissions({ 'notes.read': { description: 'Read anyone’s notes' } }),
  database: {
    schema: 'identity',
    migrations: () =>
      Promise.resolve([
        { name: '0001_bus_tables', up: createBusTablesV1 },
        {
          name: '0002_notes',
          up: async (db: Kysely<unknown>) => {
            await sql`create table notes (user_id uuid not null, body text not null)`.execute(db);
          },
        },
      ]),
  },
});

type Context = ServiceContext<typeof definition, Database>;

const router = createServiceRouter<Context>(definition);
router.route({
  method: 'GET',
  path: '/api/v1/users/:user_id/notes',
  operation_id: 'listNotes',
  summary: 'List a user’s notes',
  auth: 'session',
  permissions: ['notes.read'],
  rate_limit: 'global',
  request: { params: z.object({ user_id: z.uuid() }) },
  responses: { 200: { description: 'Notes', schema: z.object({ notes: z.array(z.string()) }) } },
  handler: async ({ ctx, params }) => {
    const rows = await ctx.db
      .selectFrom('notes')
      .select('body')
      .where('user_id', '=', params.user_id)
      .execute();
    return { status: 200 as const, body: { notes: rows.map((row) => row.body) } };
  },
});

const key = generateIdentityKey();
const userId = randomUUID();
const logs = captureLogs();

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let gateway: Bus;
let service: RunningService<typeof definition, Database>;
let erased: string[];

function config(): Pick<
  QtiauthConfig,
  'service' | 'observability' | 'bus' | 'database' | 'migrations'
> {
  return {
    service: sections.service.parse({}),
    observability: sections.observability.parse({
      logs: { user_id_hash_key: 'integration' },
      metrics: { process_metrics: false },
    }),
    bus: sections.bus.parse({ servers: [natsUrl(nats)] }),
    database: sections.database.parse({
      host: postgres.getHost(),
      port: postgres.getPort(),
      name: postgres.getDatabase(),
      roles: { identity: { user: postgres.getUsername(), password: postgres.getPassword() } },
    }),
    migrations: sections.migrations.parse({}),
  };
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  [postgres, nats] = await Promise.all([startPostgres(), startNats()]);
  gateway = await connectBus(sections.bus.parse({ servers: [natsUrl(nats)] }), 'gateway');
  serveTestIdentityKeys(gateway, key);
  erased = [];

  service = await startService(definition, {
    router,
    config: config(),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    dataRights: ({ db }) => ({
      exportUser: async (id) => {
        const rows = await db
          .selectFrom('notes')
          .select('body')
          .where('user_id', '=', id)
          .execute();
        return { notes: rows.map((row) => row.body) };
      },
      eraseUser: async (id, trx) => {
        await trx.deleteFrom('notes').where('user_id', '=', id).execute();
        erased.push(id);
      },
    }),
  });
  await service.context.db
    .insertInto('notes')
    .values([
      { user_id: userId, body: 'first' },
      { user_id: userId, body: 'second' },
    ])
    .execute();
});

afterAll(async () => {
  await service.stop();
  await gateway.close();
  await Promise.all([postgres.stop(), nats.stop()]);
});

describe('service skeleton', () => {
  it('serves health endpoints backed by the database and NATS', async () => {
    expect((await fetch(`${service.url}/healthz`)).status).toBe(200);
    const ready = await fetch(`${service.url}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: 'ok',
      checks: { nats: { status: 'ok' }, database: { status: 'ok' } },
    });
  });

  it('verifies identity tokens with keys fetched from the gateway over the bus', async () => {
    const url = `${service.url}/api/v1/users/${userId}/notes`;
    const allowed = await fetch(url, {
      headers: identityHeaders(key, 'identity', { permissions: ['notes.read'] }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ notes: ['first', 'second'] });

    const denied = await fetch(url, { headers: identityHeaders(key, 'identity') });
    expect(denied.status).toBe(403);

    const forged = await fetch(url, {
      headers: identityHeaders(generateIdentityKey(), 'identity', { permissions: ['*'] }),
    });
    expect(forged.status).toBe(401);
  });

  it('serves metrics for HTTP and the bus', async () => {
    const metrics = await (await fetch(`${service.url}/metrics`)).text();
    expect(metrics).toContain('qtiauth_http_requests_total');
    expect(metrics).toContain('qtiauth_bus_rpc_duration_seconds');
  });

  it('announces its manifest on start and when asked', async () => {
    const received: unknown[] = [];
    const sub = gateway.nc.subscribe(ANNOUNCE_SUBJECT, {
      callback: (_error, msg) => {
        received.push(msg.json());
      },
    });
    gateway.nc.publish(DISCOVER_SUBJECT);
    const announcement = serviceAnnouncementSchema.parse(
      await waitFor(() => Promise.resolve(received[0])),
    );
    await sub.drain();

    expect(announcement).toMatchObject({
      service: 'identity',
      version: '0.7.0',
      instance_id: service.context.instance_id,
      manifest: {
        routes: [{ method: 'GET', path: '/api/v1/users/:user_id/notes', auth: 'session' }],
        permissions: [{ name: 'notes.read' }],
      },
    });
  });

  it('serves OpenAPI over HTTP and the bus', async () => {
    const http = (await (await fetch(`${service.url}/openapi.json`)).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(http.paths)).toEqual(['/api/v1/users/{user_id}/notes']);

    const rpc = await rpcRequest<{ openapi: string }>(gateway, 'identity', OPENAPI_METHOD, {});
    expect(rpc).toMatchObject({ status: 'ok', data: { openapi: '3.1.1' } });
  });

  it('exports and erases a user’s data', async () => {
    const exported = await rpcRequest<UserExport>(gateway, 'identity', EXPORT_USER_METHOD, {
      user_id: userId,
    });
    expect(exported).toEqual({
      status: 'ok',
      data: { service: 'identity', data: { notes: ['first', 'second'] } },
    });

    const invalid = await rpcRequest(gateway, 'identity', EXPORT_USER_METHOD, { user_id: 'x' });
    expect(invalid).toMatchObject({ status: 'error', code: 'bad_request' });

    await (service.context.db as Kysely<unknown>).transaction().execute(async (trx) => {
      await writeEvent(trx, {
        type: USER_DELETED_EVENT,
        actor: { type: 'system', id: 'identity' },
        subject: { type: 'user', id: userId },
        data: { held: false },
      });
    });
    service.context.outbox.wake();

    await waitFor(() => Promise.resolve(erased.includes(userId) ? true : undefined));
    const remaining = await service.context.db.selectFrom('notes').selectAll().execute();
    expect(remaining).toEqual([]);
  });

  it('keeps identity tokens and raw user IDs out of the logs', async () => {
    const headers = identityHeaders(key, 'identity', { sub: userId, permissions: ['notes.read'] });
    await fetch(`${service.url}/api/v1/users/${userId}/notes`, { headers });
    assertLogsScrubbed(logs.lines, [
      headers[IDENTITY_HEADER] ?? '',
      userId,
      postgres.getPassword(),
    ]);
  });

  it('stops gracefully', async () => {
    await service.stop();
    await expect(fetch(`${service.url}/healthz`)).rejects.toThrow();
    expect(service.context.bus.nc.isClosed()).toBe(true);
    expect(logs.records().map((record) => record['message'])).toContain('service stopped');
  });
});
