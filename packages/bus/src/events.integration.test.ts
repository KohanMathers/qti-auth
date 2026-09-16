import { sections } from '@qtiauth/config';
import { createDb, type DatabaseConfig, migrate } from '@qtiauth/db';
import { type EventEnvelope, validateEnvelope } from '@qtiauth/events';
import { natsUrl, startNats, startPostgres } from '@qtiauth/testing';
import { type Kysely, sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Bus, connectBus } from './connect.ts';
import { InvalidMessageError, type RunningConsumer } from './consumer.ts';
import { consumeEvents, type EventConsumerOptions } from './events.ts';
import { type ConsumeOutcome, noopBusMetrics } from './metrics.ts';
import { createBusTablesV1, createEvent } from './outbox.ts';
import { EVENTS_STREAM, provisionStreams } from './streams.ts';

const TYPE = 'qtiauth.identity.user.banned.v1';

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let database: DatabaseConfig;
let db: Kysely<unknown>;
let bus: Bus;
let consumers: RunningConsumer[] = [];
let outcomes: ConsumeOutcome[];

function banned(userId: string): EventEnvelope {
  return createEvent({
    type: TYPE,
    actor: { type: 'system', id: 'safety' },
    subject: { type: 'user', id: userId },
    data: { reason: 'spam' },
  });
}

async function publish(event: unknown): Promise<void> {
  await bus.js.publish(TYPE, typeof event === 'string' ? event : JSON.stringify(event));
}

async function bans(): Promise<string[]> {
  const { rows } = await sql<{
    user_id: string;
  }>`select user_id from bans order by user_id`.execute(db);
  return rows.map((row) => row.user_id);
}

async function consume(
  options: Partial<EventConsumerOptions<unknown>> = {},
): Promise<RunningConsumer> {
  const consumer = await consumeEvents(bus, db, {
    name: 'bans',
    types: [TYPE],
    handler: async (event, trx) => {
      await sql`insert into bans values (${event.subject?.id})`.execute(trx);
    },
    onError: () => undefined,
    metrics: {
      ...noopBusMetrics,
      consumed: (_consumer, _subject, outcome) => outcomes.push(outcome),
    },
    ...options,
  });
  consumers.push(consumer);
  return consumer;
}

beforeAll(async () => {
  [postgres, nats] = await Promise.all([startPostgres(), startNats()]);
  database = sections.database.parse({
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
  const config = sections.bus.parse({
    servers: [natsUrl(nats)],
    consumers: { ack_wait: '2s', retry_delay: '10ms', max_retry_delay: '50ms' },
  });
  bus = await connectBus(config, 'identity');
  await provisionStreams(bus.jsm, config);
});

beforeEach(async () => {
  outcomes = [];
  await sql`truncate bans, processed_events`.execute(db);
  await bus.jsm.streams.purge(EVENTS_STREAM);
});

afterEach(async () => {
  await Promise.all(consumers.map((consumer) => consumer.stop()));
  consumers = [];
  await bus.jsm.consumers.delete(EVENTS_STREAM, 'identity-bans');
});

afterAll(async () => {
  await bus.close();
  await db.destroy();
  await Promise.all([postgres.stop(), nats.stop()]);
});

describe('consumeEvents', () => {
  it('processes a redelivered event once', async () => {
    await consume();
    const event = banned('u1');
    await publish(event);
    await publish(event);

    await vi.waitFor(() => {
      expect(outcomes).toEqual(['processed', 'duplicate']);
    });
    expect(await bans()).toEqual(['u1']);
  });

  it('acks without re-running an event committed before a crash but never acked', async () => {
    const event = banned('u2');
    await sql`
      insert into processed_events (consumer, event_id) values ('identity-bans', ${event.event_id})
    `.execute(db);
    const handler = vi.fn();
    await consume({ handler });
    await publish(event);

    await vi.waitFor(() => {
      expect(outcomes).toEqual(['duplicate']);
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rolls back and retries when the handler fails', async () => {
    const onError = vi.fn();
    let attempts = 0;
    await consume({
      onError,
      handler: async (event, trx) => {
        await sql`insert into bans values (${event.subject?.id})`.execute(trx);
        if (++attempts === 1) throw new Error('downstream unavailable');
      },
    });
    await publish(banned('u3'));

    await vi.waitFor(() => {
      expect(outcomes).toEqual(['failed', 'processed']);
    });
    expect(await bans()).toEqual(['u3']);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
      consumer: 'identity-bans',
      subject: TYPE,
      attempt: 1,
    });
  });

  it('terminates malformed events instead of retrying them', async () => {
    const onError = vi.fn();
    const handler = vi.fn();
    const consumer = await consume({
      onError,
      handler,
      catalog: {
        types: [TYPE],
        validate: (value) =>
          (value as EventEnvelope).subject?.id === 'bad-data'
            ? { valid: false, issues: ['/data/reason: must be string'] }
            : validateEnvelope(value),
      },
    });
    await publish('{not json');
    await publish({ ...banned('u4'), event_id: 'nope' });
    await publish(banned('bad-data'));
    await publish({ ...banned('u5'), type: 'qtiauth.identity.user.unbanned.v1' });

    await vi.waitFor(() => {
      expect(outcomes).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    });
    expect(handler).not.toHaveBeenCalled();
    expect(onError.mock.calls.map(([error]) => (error as Error).message)).toEqual([
      `Message on ${TYPE} isn't valid JSON`,
      expect.stringContaining(`Invalid event on ${TYPE}: /event_id: must match pattern`),
      `Invalid event on ${TYPE}: /data/reason: must be string`,
      `Event type qtiauth.identity.user.unbanned.v1 was published on ${TYPE}`,
    ]);
    expect(onError.mock.calls.every(([error]) => error instanceof InvalidMessageError)).toBe(true);
    const info = await bus.jsm.consumers.info(EVENTS_STREAM, consumer.name);
    expect(info.num_ack_pending).toBe(0);
    expect(info.num_pending).toBe(0);
  });

  it('shares events between replicas without processing any twice', async () => {
    await consume();
    await consume();
    const events = Array.from({ length: 20 }, (_, i) =>
      banned(`bulk-${String(i).padStart(2, '0')}`),
    );
    for (const event of events) await publish(event);
    await publish(events[0]);

    await vi.waitFor(() => {
      expect(outcomes).toHaveLength(21);
    });
    expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(1);
    expect(await bans()).toEqual(events.map((event) => event.subject?.id));
  });
});
