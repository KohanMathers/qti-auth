import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { SpanKind } from '@opentelemetry/api';
import { sections } from '@qtiauth/config';
import { createDb, migrate } from '@qtiauth/db';
import { traceHttpRequest } from '@qtiauth/observability';
import {
  type ReadableSpan,
  startTestTracing,
  type TestTracing,
} from '@qtiauth/observability/testing';
import { natsUrl, startNats, startPostgres } from '@qtiauth/testing';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type Bus, connectBus } from './connect.ts';
import type { RunningConsumer } from './consumer.ts';
import { consumeEvents } from './events.ts';
import { createBusTablesV1, writeEvent } from './outbox.ts';
import { type OutboxRelay, startOutboxRelay } from './relay.ts';
import { rpcRequest, type RpcServer, serveRpc } from './rpc.ts';
import { provisionStreams } from './streams.ts';

const TYPE = 'qtiauth.identity.user.banned.v1';

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let tracing: TestTracing;
let db: Kysely<unknown>;
let identity: Bus;
let notifier: Bus;
let relay: OutboxRelay;
let consumer: RunningConsumer;
let rpcServer: RpcServer;
let server: Server;
let origin: string;
const handled: string[] = [];

beforeAll(async () => {
  tracing = startTestTracing('identity');
  [postgres, nats] = await Promise.all([startPostgres(), startNats()]);
  const database = sections.database.parse({
    host: postgres.getHost(),
    port: postgres.getPort(),
    name: postgres.getDatabase(),
    roles: { identity: { user: postgres.getUsername(), password: postgres.getPassword() } },
  });
  db = createDb<unknown>(database, 'identity');
  await migrate(db, {
    schema: 'identity',
    migrations: [
      { name: '0001_bus', up: createBusTablesV1 },
      {
        name: '0002_bans',
        up: async (trx) => {
          await sql`create table bans (user_id text not null)`.execute(trx);
        },
      },
    ],
  });

  const config = sections.bus.parse({ servers: [natsUrl(nats)] });
  [identity, notifier] = await Promise.all([
    connectBus(config, 'identity'),
    connectBus(config, 'notifier'),
  ]);
  await provisionStreams(identity.jsm, config);
  relay = startOutboxRelay(identity, db, { onError: () => undefined });
  consumer = await consumeEvents(notifier, db, {
    name: 'bans',
    types: [TYPE],
    handler: async (event, trx) => {
      await sql`select 1`.execute(trx);
      handled.push(event.event_id);
    },
    onError: () => undefined,
  });
  rpcServer = serveRpc(identity, {
    method: 'get_user_summary',
    handler: async () => {
      await sql`select 1`.execute(db);
      return {};
    },
    onError: () => undefined,
  });

  server = createServer((req, res) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const request = new Request(`http://localhost${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      headers,
    });
    void traceHttpRequest(request, '/api/v1/users/:id/ban', async () => {
      await db.transaction().execute(async (trx) => {
        await sql`insert into bans values ('u1')`.execute(trx);
        await writeEvent(trx, {
          type: TYPE,
          actor: { type: 'user', id: 'staff-1' },
          subject: { type: 'user', id: 'u1' },
          data: { reason: 'spam' },
        });
      });
      relay.wake();
      await rpcRequest(identity, 'identity', 'get_user_summary', { user_id: 'u1' });
      return new Response(null, { status: 204 });
    }).then((response) => res.writeHead(response.status).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await Promise.all([relay.stop(), consumer.stop(), rpcServer.stop()]);
  await Promise.all([identity.close(), notifier.close()]);
  await db.destroy();
  await tracing.shutdown();
  await Promise.all([postgres.stop(), nats.stop()]);
});

function only(spans: ReadableSpan[], predicate: (span: ReadableSpan) => boolean): ReadableSpan {
  const matches = spans.filter(predicate);
  expect(matches).toHaveLength(1);
  const [match] = matches;
  if (match === undefined) throw new Error('No matching span');
  return match;
}

const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;
const idOf = (span: ReadableSpan) => span.spanContext().spanId;

describe('tracing across services', () => {
  it('produces one trace from HTTP through the database and bus to the consumer', async () => {
    tracing.reset();
    const response = await fetch(`${origin}/api/v1/users/u1/ban`, { method: 'POST' });
    expect(response.status).toBe(204);

    await vi.waitFor(() => {
      expect(handled).toHaveLength(1);
      expect(tracing.spans().some((span) => span.name === `process ${TYPE}`)).toBe(true);
    });

    const spans = tracing.spans();
    const http = only(
      spans,
      (span) => span.kind === SpanKind.SERVER && span.name.startsWith('POST'),
    );
    expect(parentOf(http)).toBeUndefined();
    expect(new Set(spans.map((span) => span.spanContext().traceId))).toEqual(
      new Set([http.spanContext().traceId]),
    );

    const insert = only(
      spans,
      (span) => span.attributes['db.query.text'] === "insert into bans values ('u1')",
    );
    expect(parentOf(insert)).toBe(idOf(http));

    const publish = only(spans, (span) => span.name === `send ${TYPE}`);
    expect(publish.kind).toBe(SpanKind.PRODUCER);
    expect(parentOf(publish)).toBe(idOf(http));

    const consume = only(spans, (span) => span.name === `process ${TYPE}`);
    expect(consume.kind).toBe(SpanKind.CONSUMER);
    expect(parentOf(consume)).toBe(idOf(publish));
    expect(
      spans.some((span) => span.name.startsWith('select') && parentOf(span) === idOf(consume)),
    ).toBe(true);

    const rpcClient = only(
      spans,
      (span) => span.name === 'send qtiauth.rpc.identity.get_user_summary',
    );
    const rpcServerSpan = only(
      spans,
      (span) => span.name === 'process qtiauth.rpc.identity.get_user_summary',
    );
    expect(parentOf(rpcClient)).toBe(idOf(http));
    expect(parentOf(rpcServerSpan)).toBe(idOf(rpcClient));

    const outboxQueries = spans
      .map((span) => span.attributes['db.query.text']?.toString() ?? '')
      .filter((text) => text.includes('outbox'));
    expect(outboxQueries).toHaveLength(1);
    expect(outboxQueries[0]).toMatch(/^\s*insert into outbox/);
  });
});
