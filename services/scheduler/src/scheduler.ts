import type { CronJob } from '@qtiauth/config';
import { Cron } from 'croner';

import { noopSchedulerMetrics, type SchedulerMetrics } from './metrics.ts';

const MAX_TIMER_DELAY = 2 ** 31 - 1;

export interface TickContext {
  job: string;
  scheduledAt: Date;
  attempt: number;
}

export interface SchedulerOptions {
  jobs: Readonly<Record<string, CronJob>>;
  timezone: string;
  publish: (job: string, scheduledAt: Date) => Promise<void>;
  retryDelay: (attempt: number) => number;
  retryWindow: number;
  metrics?: SchedulerMetrics;
  onPublishFailed: (error: unknown, tick: TickContext) => void;
  onDropped: (tick: TickContext) => void;
}

export interface ScheduledJob {
  name: string;
  schedule: string;
  nextRun: () => Date | null;
}

export interface RunningScheduler {
  jobs: ScheduledJob[];
  stop: () => Promise<void>;
}

export function jobSchedule(schedule: string, timezone: string): Cron {
  return new Cron(schedule, { timezone, paused: true });
}

export function nextRuns(
  jobs: Readonly<Record<string, CronJob>>,
  timezone: string,
  after: Date,
): { name: string; schedule: string; enabled: boolean; next_run: string | null }[] {
  return Object.entries(jobs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, job]) => ({
      name,
      schedule: job.schedule,
      enabled: job.enabled,
      next_run: job.enabled
        ? (jobSchedule(job.schedule, timezone).nextRun(after)?.toISOString() ?? null)
        : null,
    }));
}

export function startScheduler(options: SchedulerOptions): RunningScheduler {
  const metrics = options.metrics ?? noopSchedulerMetrics;
  const abort = new AbortController();
  const timers = new Set<NodeJS.Timeout>();
  const inFlight = new Set<Promise<void>>();

  const later = (at: number, fn: () => void) => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        if (abort.signal.aborted) return;
        if (at - Date.now() > 0) {
          later(at, fn);
        } else {
          fn();
        }
      },
      Math.min(Math.max(at - Date.now(), 0), MAX_TIMER_DELAY),
    );
    timers.add(timer);
  };

  const wait = (delay: number) =>
    new Promise<void>((resolve) => {
      if (abort.signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        abort.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, delay);
      abort.signal.addEventListener('abort', done, { once: true });
    });

  const publish = async (name: string, cron: Cron, scheduledAt: Date): Promise<void> => {
    const nextRun = cron.nextRun(scheduledAt)?.getTime() ?? Infinity;
    const giveUpAt = Math.min(scheduledAt.getTime() + options.retryWindow, nextRun);
    for (let attempt = 1; !abort.signal.aborted; attempt++) {
      try {
        await options.publish(name, scheduledAt);
        metrics.tick(name, 'published');
        return;
      } catch (error) {
        metrics.publishFailed(name);
        options.onPublishFailed(error, { job: name, scheduledAt, attempt });
        const delay = options.retryDelay(attempt);
        if (Date.now() + delay >= giveUpAt) {
          metrics.tick(name, 'dropped');
          options.onDropped({ job: name, scheduledAt, attempt });
          return;
        }
        await wait(delay);
      }
    }
  };

  const arm = (name: string, cron: Cron, after: Date) => {
    const next = cron.nextRun(after);
    metrics.nextTick(name, next);
    if (!next) return;
    later(next.getTime(), () => {
      const run = publish(name, cron, next).finally(() => {
        inFlight.delete(run);
        if (!abort.signal.aborted) arm(name, cron, new Date(Math.max(next.getTime(), Date.now())));
      });
      inFlight.add(run);
    });
  };

  const jobs: ScheduledJob[] = [];
  for (const [name, job] of Object.entries(options.jobs)) {
    if (!job.enabled) continue;
    const cron = jobSchedule(job.schedule, options.timezone);
    jobs.push({
      name,
      schedule: job.schedule,
      nextRun: () => cron.nextRun(new Date()),
    });
    arm(name, cron, new Date());
  }

  return {
    jobs,
    stop: async () => {
      abort.abort();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await Promise.all(inFlight);
    },
  };
}
