import type { Metrics } from '@qtiauth/observability';

export type BackupOutcome = 'succeeded' | 'failed';

export interface BackupMetrics {
  runs: (outcome: BackupOutcome) => void;
  duration: (seconds: number) => void;
  size: (bytes: number) => void;
  storageObjects: (count: number) => void;
  retention: (kind: 'kept' | 'deleted', count: number) => void;
  lastRun: (at: Date) => void;
}

const ignore = (): void => undefined;

export const noopBackupMetrics: BackupMetrics = {
  runs: ignore,
  duration: ignore,
  size: ignore,
  storageObjects: ignore,
  retention: ignore,
  lastRun: ignore,
};

export function prometheusBackupMetrics(metrics: Metrics): BackupMetrics {
  const runs = metrics.counter({
    name: 'qtiauth_backup_runs_total',
    help: 'Backup runs, by outcome.',
    labelNames: ['outcome'],
  });
  const duration = metrics.histogram({
    name: 'qtiauth_backup_duration_seconds',
    help: 'How long a backup takes end to end.',
    buckets: [10, 30, 60, 120, 300, 600, 1800, 3600],
  });
  const size = metrics.gauge({
    name: 'qtiauth_backup_size_bytes',
    help: 'Size of the most recent backup on disk or in storage.',
  });
  const objects = metrics.gauge({
    name: 'qtiauth_backup_storage_objects',
    help: 'Objects captured in the most recent backup manifest.',
  });
  const kept = metrics.gauge({
    name: 'qtiauth_backup_retained',
    help: 'Backups retained at the destination after the last retention sweep.',
  });
  const deleted = metrics.counter({
    name: 'qtiauth_backup_deleted_total',
    help: 'Backups deleted by retention.',
  });
  const last = metrics.gauge({
    name: 'qtiauth_backup_last_success_timestamp_seconds',
    help: 'Unix timestamp of the last successful backup.',
  });
  return {
    runs: (outcome) => {
      runs.inc({ outcome });
    },
    duration: (seconds) => {
      duration.observe(seconds);
    },
    size: (bytes) => {
      size.set(bytes);
    },
    storageObjects: (count) => {
      objects.set(count);
    },
    retention: (kind, count) => {
      if (kind === 'kept') kept.set(count);
      else deleted.inc(count);
    },
    lastRun: (at) => {
      last.set(at.getTime() / 1000);
    },
  };
}
