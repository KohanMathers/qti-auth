import { sections } from '@qtiauth/config';
import { createMetrics } from '@qtiauth/observability';
import { describe, expect, it } from 'vitest';

import { prometheusBusMetrics } from './metrics.ts';

describe('prometheusBusMetrics', () => {
  it('reports every bus metric', async () => {
    const config = sections.observability.parse({ metrics: { process_metrics: false } });
    const metrics = createMetrics(config.metrics, 'identity');
    const bus = prometheusBusMetrics(metrics);
    const subject = 'qtiauth.identity.user.banned.v1';

    bus.published(subject);
    bus.publishFailed(subject);
    bus.consumed('notifier-bans', subject, 'processed');
    bus.redelivered('notifier-bans', subject);
    bus.consumerLag('notifier-bans', 4);
    bus.outboxBacklog('identity', 3, 12.5);
    bus.rpcRequest('qtiauth.rpc.games.export_user', 'no_responders', 0.002);

    const text = await metrics.render();
    for (const line of [
      `qtiauth_bus_published_total{subject="${subject}",service="identity"} 1`,
      `qtiauth_bus_publish_failures_total{subject="${subject}",service="identity"} 1`,
      `qtiauth_bus_consumed_total{consumer="notifier-bans",subject="${subject}",outcome="processed",service="identity"} 1`,
      `qtiauth_bus_redeliveries_total{consumer="notifier-bans",subject="${subject}",service="identity"} 1`,
      'qtiauth_bus_consumer_pending{consumer="notifier-bans",service="identity"} 4',
      'qtiauth_bus_outbox_backlog{service="identity"} 3',
      'qtiauth_bus_outbox_oldest_age_seconds{service="identity"} 12.5',
      'qtiauth_bus_rpc_duration_seconds_count{service="identity",subject="qtiauth.rpc.games.export_user",outcome="no_responders"} 1',
    ]) {
      expect(text).toContain(line);
    }
  });
});
