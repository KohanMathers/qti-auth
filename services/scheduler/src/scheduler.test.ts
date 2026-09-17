import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noopSchedulerMetrics } from './metrics.ts';
import { nextRuns, type SchedulerOptions, startScheduler } from './scheduler.ts';

const START = new Date('2026-09-16T11:59:30Z');

function options(overrides: Partial<SchedulerOptions> = {}): SchedulerOptions {
  return {
    jobs: {},
    timezone: 'UTC',
    publish: () => Promise.resolve(),
    retryDelay: (attempt) => 1_000 * 2 ** (attempt - 1),
    retryWindow: 120_000,
    onPublishFailed: () => undefined,
    onDropped: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startScheduler', () => {
  it('publishes each enabled job at its scheduled times', async () => {
    const ticks: string[] = [];
    const scheduler = startScheduler(
      options({
        jobs: {
          'webhooks.retry': { schedule: '* * * * *', enabled: true },
          'support.auto_close': { schedule: '0 * * * *', enabled: true },
          'keys.rotate': { schedule: '* * * * *', enabled: false },
        },
        publish: (job, scheduledAt) => {
          ticks.push(`${job} ${scheduledAt.toISOString()}`);
          return Promise.resolve();
        },
      }),
    );

    expect(scheduler.jobs.map((job) => job.name)).toEqual(['webhooks.retry', 'support.auto_close']);
    await vi.advanceTimersByTimeAsync(150_000);

    expect(ticks).toEqual([
      'webhooks.retry 2026-09-16T12:00:00.000Z',
      'support.auto_close 2026-09-16T12:00:00.000Z',
      'webhooks.retry 2026-09-16T12:01:00.000Z',
      'webhooks.retry 2026-09-16T12:02:00.000Z',
    ]);
    await scheduler.stop();
  });

  it('reads schedules in the configured time zone', async () => {
    const publish = vi.fn(() => Promise.resolve());
    const scheduler = startScheduler(
      options({
        jobs: { 'retention.sweep': { schedule: '0 13 * * *', enabled: true } },
        timezone: 'Europe/London',
        publish,
      }),
    );

    expect(scheduler.jobs[0]?.nextRun()?.toISOString()).toBe('2026-09-16T12:00:00.000Z');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(publish).toHaveBeenCalledWith('retention.sweep', new Date('2026-09-16T12:00:00Z'));
    await scheduler.stop();
  });

  it('retries a failed publish with the same scheduled time', async () => {
    const attempts: string[] = [];
    const onPublishFailed = vi.fn();
    const metrics = { ...noopSchedulerMetrics, tick: vi.fn(), publishFailed: vi.fn() };
    const scheduler = startScheduler(
      options({
        jobs: { 'retention.sweep': { schedule: '0 12 * * *', enabled: true } },
        metrics,
        onPublishFailed,
        publish: (_job, scheduledAt) => {
          attempts.push(`${new Date().toISOString()} ${scheduledAt.toISOString()}`);
          return attempts.length < 3
            ? Promise.reject(new Error('no JetStream'))
            : Promise.resolve();
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(40_000);

    expect(attempts).toEqual([
      '2026-09-16T12:00:00.000Z 2026-09-16T12:00:00.000Z',
      '2026-09-16T12:00:01.000Z 2026-09-16T12:00:00.000Z',
      '2026-09-16T12:00:03.000Z 2026-09-16T12:00:00.000Z',
    ]);
    expect(onPublishFailed).toHaveBeenCalledTimes(2);
    expect(onPublishFailed).toHaveBeenLastCalledWith(expect.any(Error), {
      job: 'retention.sweep',
      scheduledAt: new Date('2026-09-16T12:00:00Z'),
      attempt: 2,
    });
    expect(metrics.publishFailed).toHaveBeenCalledTimes(2);
    expect(metrics.tick).toHaveBeenCalledExactlyOnceWith('retention.sweep', 'published');
    await scheduler.stop();
  });

  it('drops a tick rather than retry past the retry window or the next tick', async () => {
    const onDropped = vi.fn();
    const publish = vi.fn(() => Promise.reject(new Error('no JetStream')));
    const scheduler = startScheduler(
      options({
        jobs: { 'webhooks.retry': { schedule: '*/10 * * * * *', enabled: true } },
        retryWindow: 60_000,
        onDropped,
        publish,
      }),
    );

    await vi.advanceTimersByTimeAsync(38_000);

    expect(onDropped.mock.calls.map(([tick]) => (tick as { attempt: number }).attempt)).toEqual([
      4, 4, 4,
    ]);
    expect(publish.mock.calls.slice(0, 5)).toEqual([
      ['webhooks.retry', new Date('2026-09-16T11:59:40Z')],
      ['webhooks.retry', new Date('2026-09-16T11:59:40Z')],
      ['webhooks.retry', new Date('2026-09-16T11:59:40Z')],
      ['webhooks.retry', new Date('2026-09-16T11:59:40Z')],
      ['webhooks.retry', new Date('2026-09-16T11:59:50Z')],
    ]);
    await scheduler.stop();
  });

  it('skips ticks that passed while a publish was still running', async () => {
    const ticks: Date[] = [];
    const scheduler = startScheduler(
      options({
        jobs: { 'webhooks.retry': { schedule: '* * * * * *', enabled: true } },
        publish: async (_job, scheduledAt) => {
          ticks.push(scheduledAt);
          await new Promise((resolve) => setTimeout(resolve, 2_500));
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(8_000);

    expect(ticks.map((tick) => tick.toISOString())).toEqual([
      '2026-09-16T11:59:31.000Z',
      '2026-09-16T11:59:34.000Z',
      '2026-09-16T11:59:37.000Z',
    ]);
    const stopped = scheduler.stop();
    await vi.advanceTimersByTimeAsync(2_500);
    await stopped;
  });

  it('stops ticking and waits for a publish in progress', async () => {
    let finished = false;
    const publish = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      finished = true;
    });
    const scheduler = startScheduler(
      options({
        jobs: { 'webhooks.retry': { schedule: '* * * * *', enabled: true } },
        publish,
      }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    const stopped = scheduler.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;

    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('stops without waiting out a retry delay', async () => {
    const publish = vi.fn(() => Promise.reject(new Error('no JetStream')));
    const scheduler = startScheduler(
      options({
        jobs: { 'webhooks.retry': { schedule: '* * * * *', enabled: true } },
        retryDelay: () => 60_000,
        retryWindow: 3_600_000,
        publish,
      }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await scheduler.stop();

    expect(publish).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits out delays longer than a timer allows', async () => {
    const publish = vi.fn(() => Promise.resolve());
    const scheduler = startScheduler(
      options({ jobs: { 'yearly.report': { schedule: '0 0 1 1 *', enabled: true } }, publish }),
    );

    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(Date.parse('2027-01-01T00:00:00Z') - Date.now());
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      'yearly.report',
      new Date('2027-01-01T00:00:00Z'),
    );
    await scheduler.stop();
  });
});

describe('nextRuns', () => {
  it('lists every job with its next run, sorted by name', () => {
    expect(
      nextRuns(
        {
          'webhooks.retry': { schedule: '* * * * *', enabled: true },
          'backup.run': { schedule: '30 2 * * *', enabled: true },
          'steam.ownership_sync': { schedule: '0 5 * * *', enabled: false },
        },
        'Europe/London',
        START,
      ),
    ).toEqual([
      {
        name: 'backup.run',
        schedule: '30 2 * * *',
        enabled: true,
        next_run: '2026-09-17T01:30:00.000Z',
      },
      {
        name: 'steam.ownership_sync',
        schedule: '0 5 * * *',
        enabled: false,
        next_run: null,
      },
      {
        name: 'webhooks.retry',
        schedule: '* * * * *',
        enabled: true,
        next_run: '2026-09-16T12:00:00.000Z',
      },
    ]);
  });
});
