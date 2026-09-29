import { publishCronTick, retryDelay } from '@qtiauth/bus';
import type { StartServiceOptions } from '@qtiauth/service-kit';

import { prometheusSchedulerMetrics } from './metrics.ts';
import { startScheduler } from './scheduler.ts';
import { type Context, type definition, router } from './service.ts';

export function schedulerService() {
  return {
    router,
    start: (ctx: Context) => {
      const { config, log, bus } = ctx;
      const scheduler = startScheduler({
        jobs: config.scheduler.jobs,
        timezone: config.scheduler.timezone,
        publish: (job, scheduledAt) => publishCronTick(bus.js, job, scheduledAt),
        retryDelay: (attempt) => retryDelay(attempt, config.bus.consumers),
        retryWindow: config.bus.streams.duplicate_window,
        metrics: prometheusSchedulerMetrics(ctx.metrics),
        onPublishFailed: (error, tick) => {
          log.warn('cron tick publish failed', {
            error,
            job: tick.job,
            scheduled_at: tick.scheduledAt.toISOString(),
            attempt: tick.attempt,
          });
        },
        onDropped: (tick) => {
          log.error('cron tick dropped', {
            job: tick.job,
            scheduled_at: tick.scheduledAt.toISOString(),
            attempts: tick.attempt,
          });
        },
      });
      log.info('scheduler started', {
        timezone: config.scheduler.timezone,
        jobs: scheduler.jobs.map((job) => ({
          job: job.name,
          schedule: job.schedule,
          next_run: job.nextRun()?.toISOString() ?? null,
        })),
      });
      return Promise.resolve([scheduler]);
    },
  } satisfies StartServiceOptions<typeof definition, unknown>;
}
