import { sections } from '@qtiauth/config';
import { createMetrics } from '@qtiauth/observability';
import { describe, expect, it } from 'vitest';

import { prometheusNotifierMetrics } from './metrics.ts';

describe('prometheusNotifierMetrics', () => {
  it('reports deliveries, send latency and delivery delay', async () => {
    const config = sections.observability.parse({ metrics: { process_metrics: false } });
    const metrics = createMetrics(config.metrics, 'notifier');
    const notifier = prometheusNotifierMetrics(metrics);

    notifier.delivery('smtp', 'magic_link', 'retrying');
    notifier.delivery('smtp', 'magic_link', 'sent');
    notifier.sendAttempt('smtp', 'error', 0.2);
    notifier.sendAttempt('smtp', 'ok', 0.3);
    notifier.deliveryDelay('high', 12);

    const text = await metrics.render();
    for (const line of [
      'qtiauth_email_deliveries_total{provider="smtp",template="magic_link",status="retrying",service="notifier"} 1',
      'qtiauth_email_deliveries_total{provider="smtp",template="magic_link",status="sent",service="notifier"} 1',
      'qtiauth_email_send_duration_seconds_count{service="notifier",provider="smtp",outcome="error"} 1',
      'qtiauth_email_send_duration_seconds_sum{service="notifier",provider="smtp",outcome="ok"} 0.3',
      'qtiauth_email_delivery_delay_seconds_sum{service="notifier",priority="high"} 12',
    ]) {
      expect(text).toContain(line);
    }
  });
});
