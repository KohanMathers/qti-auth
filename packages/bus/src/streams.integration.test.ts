import { nanos } from '@nats-io/transport-node';
import { sections } from '@qtiauth/config';
import { natsUrl, startNats } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Bus, connectBus } from './connect.ts';
import {
  CRON_STREAM,
  ensureConsumer,
  EVENTS_STREAM,
  provisionStreams,
  WORK_STREAM,
} from './streams.ts';

let nats: Awaited<ReturnType<typeof startNats>>;
let bus: Bus;

beforeAll(async () => {
  nats = await startNats();
  bus = await connectBus(sections.bus.parse({ servers: [natsUrl(nats)] }), 'identity');
});

afterAll(async () => {
  await bus.close();
  await nats.stop();
});

describe('provisionStreams', () => {
  it('creates the streams and updates them when config changes', async () => {
    const config = sections.bus.parse({ servers: [natsUrl(nats)] });
    await Promise.all([provisionStreams(bus.jsm, config), provisionStreams(bus.jsm, config)]);

    const retention = async (name: string) => (await bus.jsm.streams.info(name)).config.retention;
    expect(await retention(EVENTS_STREAM)).toBe('limits');
    expect(await retention(CRON_STREAM)).toBe('interest');
    expect(await retention(WORK_STREAM)).toBe('workqueue');

    await provisionStreams(bus.jsm, sections.bus.parse({ streams: { events_max_age: '3d' } }));
    const { config: events } = await bus.jsm.streams.info(EVENTS_STREAM);
    expect(events.max_age).toBe(nanos(3 * 86_400_000));
    expect(events.duplicate_window).toBe(nanos(120_000));
  });
});

describe('ensureConsumer', () => {
  it('creates a durable consumer once when replicas start together, then applies changes', async () => {
    const consumer = {
      stream: EVENTS_STREAM,
      name: 'identity-bans',
      subjects: ['qtiauth.safety.report.actioned.v1'],
      startFrom: 'new' as const,
      ackWait: 30_000,
      maxDeliver: 10,
    };
    await Promise.all([ensureConsumer(bus.jsm, consumer), ensureConsumer(bus.jsm, consumer)]);

    await ensureConsumer(bus.jsm, {
      ...consumer,
      subjects: [...consumer.subjects, 'qtiauth.safety.report.dismissed.v1'],
      maxDeliver: 5,
    });
    const info = await bus.jsm.consumers.info(EVENTS_STREAM, 'identity-bans');
    expect(info.config).toMatchObject({
      durable_name: 'identity-bans',
      ack_policy: 'explicit',
      deliver_policy: 'new',
      max_deliver: 5,
      ack_wait: nanos(30_000),
      filter_subjects: ['qtiauth.safety.report.actioned.v1', 'qtiauth.safety.report.dismissed.v1'],
    });
  });
});
