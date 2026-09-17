import type { Metrics } from '@qtiauth/observability';

export type ConsumeOutcome = 'processed' | 'duplicate' | 'failed' | 'rejected';
export type RpcOutcome = 'ok' | 'error' | 'timeout' | 'no_responders';
export type CronRunOutcome = 'succeeded' | 'failed';

export interface BusMetrics {
  published: (subject: string) => void;
  publishFailed: (subject: string) => void;
  consumed: (consumer: string, subject: string, outcome: ConsumeOutcome) => void;
  redelivered: (consumer: string, subject: string) => void;
  consumerLag: (consumer: string, pending: number) => void;
  outboxBacklog: (service: string, size: number, oldestAgeSeconds: number) => void;
  rpcRequest: (subject: string, outcome: RpcOutcome, seconds: number) => void;
  cronRun: (job: string, outcome: CronRunOutcome, seconds: number) => void;
}

const ignore = (): void => undefined;

export const noopBusMetrics: BusMetrics = {
  published: ignore,
  publishFailed: ignore,
  consumed: ignore,
  redelivered: ignore,
  consumerLag: ignore,
  outboxBacklog: ignore,
  rpcRequest: ignore,
  cronRun: ignore,
};

export function prometheusBusMetrics(metrics: Metrics): BusMetrics {
  const published = metrics.counter({
    name: 'qtiauth_bus_published_total',
    help: 'Messages published, by subject.',
    labelNames: ['subject'],
  });
  const publishFailures = metrics.counter({
    name: 'qtiauth_bus_publish_failures_total',
    help: 'Failed publishes, by subject.',
    labelNames: ['subject'],
  });
  const consumed = metrics.counter({
    name: 'qtiauth_bus_consumed_total',
    help: 'Messages handled, by consumer, subject and outcome.',
    labelNames: ['consumer', 'subject', 'outcome'],
  });
  const redeliveries = metrics.counter({
    name: 'qtiauth_bus_redeliveries_total',
    help: 'Messages delivered again after a failure or timeout.',
    labelNames: ['consumer', 'subject'],
  });
  const pending = metrics.gauge({
    name: 'qtiauth_bus_consumer_pending',
    help: 'Messages waiting for a consumer.',
    labelNames: ['consumer'],
  });
  const backlog = metrics.gauge({
    name: 'qtiauth_bus_outbox_backlog',
    help: 'Unsent events in the outbox.',
  });
  const oldestAge = metrics.gauge({
    name: 'qtiauth_bus_outbox_oldest_age_seconds',
    help: 'Age of the oldest unsent event in the outbox.',
  });
  const rpc = metrics.histogram({
    name: 'qtiauth_bus_rpc_duration_seconds',
    help: 'Request/reply latency, by subject and outcome.',
    labelNames: ['subject', 'outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });
  const cronRuns = metrics.counter({
    name: 'qtiauth_cron_runs_total',
    help: 'Scheduled job runs, by job and outcome. A failed run is retried.',
    labelNames: ['cron_job', 'outcome'],
  });
  const cronDuration = metrics.histogram({
    name: 'qtiauth_cron_run_duration_seconds',
    help: 'How long scheduled job runs take, by job and outcome.',
    labelNames: ['cron_job', 'outcome'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 900, 1800, 3600],
  });

  return {
    published: (subject) => {
      published.inc({ subject });
    },
    publishFailed: (subject) => {
      publishFailures.inc({ subject });
    },
    consumed: (consumer, subject, outcome) => {
      consumed.inc({ consumer, subject, outcome });
    },
    redelivered: (consumer, subject) => {
      redeliveries.inc({ consumer, subject });
    },
    consumerLag: (consumer, count) => {
      pending.set({ consumer }, count);
    },
    outboxBacklog: (_service, size, oldestAgeSeconds) => {
      backlog.set(size);
      oldestAge.set(oldestAgeSeconds);
    },
    rpcRequest: (subject, outcome, seconds) => {
      rpc.observe({ subject, outcome }, seconds);
    },
    cronRun: (job, outcome, seconds) => {
      cronRuns.inc({ cron_job: job, outcome });
      cronDuration.observe({ cron_job: job, outcome }, seconds);
    },
  };
}
