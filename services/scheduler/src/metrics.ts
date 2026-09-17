import type { Metrics } from '@qtiauth/observability';

export type TickOutcome = 'published' | 'dropped';

export interface SchedulerMetrics {
  tick: (job: string, outcome: TickOutcome) => void;
  publishFailed: (job: string) => void;
  nextTick: (job: string, at: Date | null) => void;
}

const ignore = (): void => undefined;

export const noopSchedulerMetrics: SchedulerMetrics = {
  tick: ignore,
  publishFailed: ignore,
  nextTick: ignore,
};

export function prometheusSchedulerMetrics(metrics: Metrics): SchedulerMetrics {
  const ticks = metrics.counter({
    name: 'qtiauth_scheduler_ticks_total',
    help: 'Cron ticks, by job and outcome: published, or dropped after publishing kept failing.',
    labelNames: ['cron_job', 'outcome'],
  });
  const failures = metrics.counter({
    name: 'qtiauth_scheduler_publish_failures_total',
    help: 'Failed attempts to publish a cron tick, by job. Failed attempts are retried.',
    labelNames: ['cron_job'],
  });
  const next = metrics.gauge({
    name: 'qtiauth_scheduler_next_tick_timestamp_seconds',
    help: 'When each job next ticks, as a Unix timestamp.',
    labelNames: ['cron_job'],
  });

  return {
    tick: (job, outcome) => {
      ticks.inc({ cron_job: job, outcome });
    },
    publishFailed: (job) => {
      failures.inc({ cron_job: job });
    },
    nextTick: (job, at) => {
      if (at) {
        next.set({ cron_job: job }, at.getTime() / 1000);
      } else {
        next.remove({ cron_job: job });
      }
    },
  };
}
