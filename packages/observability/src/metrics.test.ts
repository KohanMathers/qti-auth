import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { createMetrics, MetricDefinitionError, metricsResponse } from './metrics.ts';

const config = (processMetrics = false) =>
  sections.observability.parse({ metrics: { process_metrics: processMetrics } }).metrics;

describe('createMetrics', () => {
  it('renders metrics with the service label', async () => {
    const metrics = createMetrics(config(), 'identity');
    const signIns = metrics.counter({
      name: 'qtiauth_auth_sign_ins_total',
      help: 'Sign-ins by method and result.',
      labelNames: ['method', 'result'],
    });
    signIns.inc({ method: 'password', result: 'success' });

    const response = await metricsResponse(metrics);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain(
      'qtiauth_auth_sign_ins_total{method="password",result="success",service="identity"} 1',
    );
  });

  it('rejects labels that would hold unbounded values', () => {
    const metrics = createMetrics(config(), 'identity');
    for (const label of ['user_id', 'email', 'ip', 'id', 'session_id', 'User_Agent', 'service']) {
      expect(() =>
        metrics.counter({ name: 'qtiauth_test_total', help: 'Test.', labelNames: [label] }),
      ).toThrow(MetricDefinitionError);
    }
    expect(() =>
      metrics.histogram({
        name: 'qtiauth_test_seconds',
        help: 'Test.',
        labelNames: ['route', 'status'],
        buckets: [0.1, 1],
      }),
    ).not.toThrow();
  });

  it('requires the qtiauth_ prefix and snake_case names', () => {
    const metrics = createMetrics(config(), 'identity');
    expect(() => metrics.gauge({ name: 'sessions_active', help: 'Test.' })).toThrow(
      'must be snake_case and start with qtiauth_',
    );
    expect(() => metrics.gauge({ name: 'qtiauth_Sessions', help: 'Test.' })).toThrow(
      MetricDefinitionError,
    );
  });

  it('includes process metrics when enabled', async () => {
    const text = await createMetrics(config(true), 'identity').render();
    expect(text).toContain('qtiauth_process_cpu_user_seconds_total');
  });
});
