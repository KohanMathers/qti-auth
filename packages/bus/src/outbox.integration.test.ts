import type { JetStreamClient } from '@nats-io/jetstream';
import { sections } from '@qtiauth/config';
import { createDb, type DatabaseConfig, migrate } from '@qtiauth/db';
import type { EventEnvelope } from '@qtiauth/events';
import { natsUrl, startNats, startPostgres } from '@qtiauth/testing';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Bus, type BusConfig, connectBus } from './connect.ts';
import { noopBusMetrics } from './metrics.ts';
import {
  createBusTablesV1,
  type NewEvent,
  outboxStats,
  pruneBusTables,
  writeEvent,
} from './outbox.ts';
import { publishEvent, relayOutbox, startOutboxRelay } from './relay.ts';
import { EVENTS_STREAM, provisionStreams } from './streams.ts';

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let database: DatabaseConfig;
let config: BusConfig;
let db: Kysely<unknown>;
let bus: Bus;
const closers: (() => Promise<void>)[] = [];

function banned(userId: string): NewEvent<{ reason: string }> {
  return {
    type: 'qtiauth.identity.user.banned.v1',
    actor: { type: 'user', id: 'staff-1' },
    subject: { type: 'user', id: userId },
    data: { reason: 'spam' },
  };
}

function replicaDb(): Kysely<unknown> {
  const replica = createDb<unknown>(database, 'identity');
  closers.push(() => replica.destroy());
  return replica;
}

async function streamEvents(): Promise<EventEnvelope[]> {
  const { state } = await bus.jsm.streams.info(EVENTS_STREAM);
  const events: EventEnvelope[] = [];
  for (let seq = state.first_seq; state.messages > 0 && seq <= state.last_seq; seq++) {
    const msg = await bus.jsm.streams.getMessage(EVENTS_STREAM, { seq });
    if (msg) events.push(msg.json<EventEnvelope>());
  }
  return events;
}

beforeAll(async () => {
  [postgres, nats] = await Promise.all([startPostgres(), startNats()]);
  database = sections.database.parse({
    host: postgres.getHost(),
    port: postgres.getPort(),
    name: postgres.getDatabase(),
    roles: { identity: { user: postgres.getUsername(), password: postgres.getPassword() } },
  });
  config = sections.bus.parse({ servers: [natsUrl(nats)] });
  db = replicaDb();
  await migrate(db, {
    schema: 'identity',
    migrations: [{ name: '0001_bus', up: createBusTablesV1 }],
  });
  bus = await connectBus(config, 'identity');
  closers.push(() => bus.close());
  await provisionStreams(bus.jsm, config);
});

beforeEach(async () => {
  await sql`truncate outbox, processed_events`.execute(db);
  await bus.jsm.streams.purge(EVENTS_STREAM);
});

afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
  await Promise.all([postgres.stop(), nats.stop()]);
});

describe('transactional outbox', () => {
  it('loses no events when the service dies between commit and publish', async () => {
    const crashed = createDb<unknown>(database, 'identity');
    const event = await crashed.transaction().execute((trx) => writeEvent(trx, banned('u1')));
    await crashed.destroy();

    const restarted = replicaDb();
    expect(await outboxStats(restarted)).toMatchObject({ backlog: 1 });
    await expect(relayOutbox(restarted, bus.js, { batchSize: 100 })).resolves.toBe(1);

    expect(await streamEvents()).toEqual([event]);
    expect(await outboxStats(restarted)).toEqual({ backlog: 0, oldestAgeSeconds: 0 });
  });

  it('publishes an event once when the relay dies after publishing but before marking it sent', async () => {
    const event = await db.transaction().execute((trx) => writeEvent(trx, banned('u2')));
    await publishEvent(bus.js, event);

    await expect(relayOutbox(db, bus.js, { batchSize: 100 })).resolves.toBe(1);
    expect(await streamEvents()).toEqual([event]);
  });

  it('publishes nothing from a rolled-back transaction', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await writeEvent(trx, banned('u3'));
        throw new Error('state change failed');
      }),
    ).rejects.toThrow('state change failed');

    await expect(relayOutbox(db, bus.js, { batchSize: 100 })).resolves.toBe(0);
    expect(await streamEvents()).toEqual([]);
  });

  it('keeps unsent events when publishing fails part-way through a batch', async () => {
    const events = await db
      .transaction()
      .execute(async (trx) => [
        await writeEvent(trx, banned('u4')),
        await writeEvent(trx, banned('u5')),
        await writeEvent(trx, banned('u6')),
      ]);
    let publishes = 0;
    const flaky = {
      publish: (...args: Parameters<JetStreamClient['publish']>) => {
        if (++publishes === 2) return Promise.reject(new Error('nats unavailable'));
        return bus.js.publish(...args);
      },
    } as JetStreamClient;
    const metrics = { ...noopBusMetrics, publishFailed: vi.fn() };

    await expect(relayOutbox(db, flaky, { batchSize: 100, metrics })).rejects.toThrow(
      'nats unavailable',
    );
    expect(metrics.publishFailed).toHaveBeenCalledWith('qtiauth.identity.user.banned.v1');
    expect(await outboxStats(db)).toMatchObject({ backlog: 2 });

    await expect(relayOutbox(db, bus.js, { batchSize: 100 })).resolves.toBe(2);
    expect(await streamEvents()).toEqual(events);
  });

  it('publishes in order, once, when several replicas relay at once', async () => {
    const events = await db.transaction().execute(async (trx) => {
      const written: EventEnvelope[] = [];
      for (let i = 0; i < 25; i++) written.push(await writeEvent(trx, banned(`bulk-${String(i)}`)));
      return written;
    });

    const replicas = [replicaDb(), replicaDb(), replicaDb()];
    while ((await outboxStats(db)).backlog > 0) {
      await Promise.all(replicas.map((replica) => relayOutbox(replica, bus.js, { batchSize: 4 })));
    }
    expect((await streamEvents()).map((event) => event.event_id)).toEqual(
      events.map((event) => event.event_id),
    );
  });

  it('relays in the background, wakes on demand and reports the backlog', async () => {
    const metrics = { ...noopBusMetrics, outboxBacklog: vi.fn() };
    const onError = vi.fn();
    const relay = startOutboxRelay(
      { ...bus, config: sections.bus.parse({ outbox: { poll_interval: '1h' } }) },
      db,
      { onError, metrics },
    );
    try {
      await vi.waitFor(() => {
        expect(metrics.outboxBacklog).toHaveBeenCalledWith(0, 0);
      });
      const event = await db.transaction().execute((trx) => writeEvent(trx, banned('u7')));
      relay.wake();
      await vi.waitFor(async () => {
        expect(await streamEvents()).toEqual([event]);
      });
    } finally {
      await relay.stop();
    }
    expect(onError).not.toHaveBeenCalled();
  });

  it('prunes sent events and old dedupe records', async () => {
    await db.transaction().execute(async (trx) => {
      await writeEvent(trx, banned('old'));
      await writeEvent(trx, banned('recent'));
      await writeEvent(trx, banned('unsent'));
    });
    await sql`
      update outbox set sent_at = case
        when envelope->'subject'->>'id' = 'old' then now() - interval '2 days'
        when envelope->'subject'->>'id' = 'recent' then now()
      end
    `.execute(db);
    await sql`
      insert into processed_events (consumer, event_id, processed_at) values
        ('identity-bans', 'old', now() - interval '15 days'),
        ('identity-bans', 'recent', now())
    `.execute(db);

    await expect(pruneBusTables(db, config)).resolves.toEqual({ outbox: 1, processedEvents: 1 });
    const { rows } = await sql<{ id: string }>`
      select envelope->'subject'->>'id' as id from outbox order by id
    `.execute(db);
    expect(rows.map((row) => row.id)).toEqual(['recent', 'unsent']);
  });
});
