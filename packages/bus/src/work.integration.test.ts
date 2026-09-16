import { sections } from '@qtiauth/config';
import { natsUrl, startNats } from '@qtiauth/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { type Bus, type BusConfig, connectBus } from './connect.ts';
import { InvalidMessageError, type RunningConsumer } from './consumer.ts';
import { CRON_STREAM, provisionStreams, WORK_STREAM } from './streams.ts';
import { workSubject } from './subjects.ts';
import { consumeCron, consumeWork, type CronTick, publishCronTick, publishWork } from './work.ts';

let nats: Awaited<ReturnType<typeof startNats>>;
let config: BusConfig;
const buses: Bus[] = [];
let consumers: RunningConsumer[] = [];

async function service(name: string): Promise<Bus> {
  const bus = await connectBus(config, name);
  buses.push(bus);
  return bus;
}

function track(consumer: RunningConsumer): RunningConsumer {
  consumers.push(consumer);
  return consumer;
}

beforeAll(async () => {
  nats = await startNats();
  config = sections.bus.parse({
    servers: [natsUrl(nats)],
    consumers: { ack_wait: '2s', retry_delay: '10ms', max_retry_delay: '50ms' },
  });
  const bus = await service('setup');
  await provisionStreams(bus.jsm, config);
});

afterEach(async () => {
  await Promise.all(consumers.map((consumer) => consumer.stop()));
  const [bus] = buses;
  for (const consumer of consumers) {
    const stream = consumer.name.includes('-cron-') ? CRON_STREAM : WORK_STREAM;
    await bus?.jsm.consumers.delete(stream, consumer.name).catch(() => false);
  }
  consumers = [];
});

afterAll(async () => {
  await Promise.all(buses.map((bus) => bus.close()));
  await nats.stop();
});

describe('work queues', () => {
  it('hands each job to exactly one replica', async () => {
    const handled: number[] = [];
    const replicas = [await service('notifier'), await service('notifier')] as const;
    for (const bus of replicas) {
      track(
        await consumeWork<{ n: number }>(bus, {
          queue: 'email',
          handler: async (job) => {
            handled.push(job.data.n);
            await Promise.resolve();
          },
          onError: () => undefined,
        }),
      );
    }

    const identity = await service('identity');
    for (let n = 0; n < 20; n++) {
      await publishWork(identity.js, workSubject('notifier', 'email'), { n });
    }

    await vi.waitFor(() => {
      expect(handled).toHaveLength(20);
    });
    expect(new Set(handled).size).toBe(20);
  });

  it('retries a failed job and tells the handler which attempt it is', async () => {
    const bus = await service('notifier');
    const attempts: number[] = [];
    const onError = vi.fn();
    track(
      await consumeWork(bus, {
        queue: 'email',
        handler: async (job) => {
          attempts.push(job.attempt);
          await Promise.resolve();
          if (job.attempt === 1) throw new Error('provider outage');
        },
        onError,
      }),
    );

    await publishWork(bus.js, workSubject('notifier', 'email'), { to: 'user' }, { id: 'job-1' });

    await vi.waitFor(() => {
      expect(attempts).toEqual([1, 2]);
    });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('terminates jobs that are not JSON', async () => {
    const bus = await service('notifier');
    const onError = vi.fn();
    const handler = vi.fn();
    const consumer = track(await consumeWork(bus, { queue: 'email', handler, onError }));

    await bus.js.publish(workSubject('notifier', 'email'), '{broken');

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.any(InvalidMessageError), {
        consumer: consumer.name,
        subject: 'qtiauth.work.notifier.email',
        attempt: 1,
      });
    });
    expect(handler).not.toHaveBeenCalled();
    const info = await bus.jsm.consumers.info(WORK_STREAM, consumer.name);
    expect(info.num_ack_pending).toBe(0);
  });
});

describe('cron', () => {
  it('runs a tick once per owning service, even if two schedulers publish it', async () => {
    const runs: string[] = [];
    for (const name of ['identity', 'identity', 'notifier', 'notifier']) {
      const bus = await service(name);
      track(
        await consumeCron(bus, {
          job: 'retention.sweep',
          handler: async (tick) => {
            runs.push(`${name} ${tick.data.job} ${tick.data.scheduled_at} ${String(tick.id)}`);
            await Promise.resolve();
          },
          onError: () => undefined,
        }),
      );
    }

    const scheduledAt = new Date('2026-09-16T03:00:00Z');
    const schedulers = [await service('scheduler'), await service('scheduler')];
    await Promise.all(
      schedulers.map((scheduler) => publishCronTick(scheduler.js, 'retention.sweep', scheduledAt)),
    );

    await vi.waitFor(() => {
      expect(runs).toHaveLength(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const tick: CronTick = { job: 'retention.sweep', scheduled_at: scheduledAt.toISOString() };
    const id = `retention.sweep@${tick.scheduled_at}`;
    expect(runs.sort()).toEqual([
      `identity ${tick.job} ${tick.scheduled_at} ${id}`,
      `notifier ${tick.job} ${tick.scheduled_at} ${id}`,
    ]);
  });
});
