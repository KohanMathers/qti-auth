import { sections } from '@qtiauth/config';
import { createMetrics } from '@qtiauth/observability';
import { describe, expect, it } from 'vitest';

import { prometheusSchedulerMetrics } from './metrics.ts';

describe('prometheusSchedulerMetrics', () => {
  it('reports ticks, publish failures and the next tick', async () => {
    const config = sections.observability.parse({ metrics: { process_metrics: false } });
    const metrics = createMetrics(config.metrics, 'scheduler');
    const scheduler = prometheusSchedulerMetrics(metrics);

    scheduler.tick('retention.sweep', 'published');
    scheduler.tick('retention.sweep', 'dropped');
    scheduler.publishFailed('retention.sweep');
    scheduler.nextTick('retention.sweep', new Date('2026-09-17T03:00:00Z'));
    scheduler.nextTick('backup.run', new Date('2026-09-17T02:30:00Z'));
    scheduler.nextTick('backup.run', null);

    const text = await metrics.render();
    for (const line of [
      'qtiauth_scheduler_ticks_total{cron_job="retention.sweep",outcome="published",service="scheduler"} 1',
      'qtiauth_scheduler_ticks_total{cron_job="retention.sweep",outcome="dropped",service="scheduler"} 1',
      'qtiauth_scheduler_publish_failures_total{cron_job="retention.sweep",service="scheduler"} 1',
      'qtiauth_scheduler_next_tick_timestamp_seconds{cron_job="retention.sweep",service="scheduler"} 1789614000',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toContain('cron_job="backup.run"');
  });
});
