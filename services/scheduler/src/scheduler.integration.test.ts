import {
  type Bus,
  connectBus,
  consumeCron,
  provisionStreams,
  type RunningConsumer,
} from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { captureLogs } from '@qtiauth/observability/testing';
import { type RunningService, startService } from '@qtiauth/service-kit';
import { natsUrl, startNats } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { definition } from './service.ts';
import { schedulerService } from './start.ts';

const JOB = 'test.every_second';

let nats: Awaited<ReturnType<typeof startNats>>;
const buses: Bus[] = [];
const consumers: RunningConsumer[] = [];
const schedulers: RunningService<typeof definition>[] = [];

function config() {
  const bus = sections.bus.parse({
    servers: [natsUrl(nats)],
    consumers: { retry_delay: '10ms', max_retry_delay: '50ms' },
  });
  return {
    service: sections.service.parse({}),
    observability: sections.observability.parse({ metrics: { process_metrics: false } }),
    bus,
    database: sections.database.parse({}),
    migrations: sections.migrations.parse({}),
    scheduler: sections.scheduler.parse({
      jobs: { [JOB]: { schedule: '* * * * * *' } },
    }),
  };
}

function startScheduler() {
  return startService(definition, {
    ...schedulerService(),
    config: config(),
    port: 0,
    tracing: false,
    logDestination: captureLogs().destination,
  });
}

beforeAll(async () => {
  nats = await startNats();
});

afterAll(async () => {
  await Promise.all(schedulers.map((scheduler) => scheduler.stop()));
  await Promise.all(consumers.map((consumer) => consumer.stop()));
  await Promise.all(buses.map((bus) => bus.close()));
  await nats.stop();
});

describe('scheduler', () => {
  it('runs a job with 3 consumer replicas exactly once per tick, with 2 schedulers', async () => {
    const runs: { replica: number; scheduledAt: string }[] = [];
    for (const replica of [1, 2, 3]) {
      const bus = await connectBus(config().bus, 'identity');
      buses.push(bus);
      await provisionStreams(bus.jsm, config().bus);
      consumers.push(
        await consumeCron(bus, {
          job: JOB,
          handler: async (tick) => {
            runs.push({ replica, scheduledAt: tick.data.scheduled_at });
            await Promise.resolve();
          },
          onError: () => undefined,
        }),
      );
    }

    schedulers.push(await startScheduler(), await startScheduler());

    await vi.waitFor(
      () => {
        expect(new Set(runs.map((run) => run.scheduledAt)).size).toBeGreaterThanOrEqual(4);
      },
      { timeout: 10_000, interval: 100 },
    );
    await Promise.all(schedulers.map((scheduler) => scheduler.stop()));
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const perTick = Map.groupBy(runs, (run) => run.scheduledAt);
    for (const [scheduledAt, handled] of perTick) {
      expect(handled, scheduledAt).toHaveLength(1);
      expect(Date.parse(scheduledAt) % 1_000, scheduledAt).toBe(0);
    }
  });

  it('reports ticks it published', async () => {
    const scheduler = await startScheduler();
    schedulers.push(scheduler);

    await vi.waitFor(
      async () => {
        const metrics = await (await fetch(`${scheduler.url}/metrics`)).text();
        expect(metrics).toMatch(
          /qtiauth_scheduler_ticks_total\{cron_job="test\.every_second",outcome="published",service="scheduler"\} [1-9]/,
        );
        expect(metrics).toContain(
          'qtiauth_scheduler_next_tick_timestamp_seconds{cron_job="retention.sweep",service="scheduler"}',
        );
      },
      { timeout: 5_000, interval: 200 },
    );
    expect(await (await fetch(`${scheduler.url}/readyz`)).json()).toMatchObject({
      status: 'ok',
      service: 'scheduler',
    });
  });
});
