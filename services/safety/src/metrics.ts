import type { Metrics } from '@qtiauth/observability';

export type ReportOutcome = 'actioned' | 'dismissed';
export type AppealMetricOutcome = 'opened' | 'lifted' | 'upheld';

export interface SafetyMetrics {
  reportReceived: (type: string, source: string) => void;
  reportClosed: (outcome: ReportOutcome) => void;
  action: (action: string) => void;
  slaBreached: () => void;
  appeal: (outcome: AppealMetricOutcome) => void;
  timeToAction: (seconds: number) => void;
  queueDepth: (priority: string, count: number) => void;
}

const created = new WeakMap<Metrics, SafetyMetrics>();

export function safetyMetrics(metrics: Metrics): SafetyMetrics {
  let safety = created.get(metrics);
  if (!safety) {
    safety = prometheusSafetyMetrics(metrics);
    created.set(metrics, safety);
  }
  return safety;
}

function prometheusSafetyMetrics(metrics: Metrics): SafetyMetrics {
  const received = metrics.counter({
    name: 'qtiauth_safety_reports_total',
    help: 'Safety reports accepted, by type and source.',
    labelNames: ['type', 'source'],
  });
  const closed = metrics.counter({
    name: 'qtiauth_safety_reports_closed_total',
    help: 'Safety reports closed, by outcome: actioned or dismissed.',
    labelNames: ['outcome'],
  });
  const actions = metrics.counter({
    name: 'qtiauth_safety_actions_total',
    help: 'Moderation actions applied, by action type.',
    labelNames: ['action'],
  });
  const sla = metrics.counter({
    name: 'qtiauth_safety_sla_breaches_total',
    help: 'Reports whose first-action SLA was missed.',
  });
  const appeals = metrics.counter({
    name: 'qtiauth_safety_appeals_total',
    help: 'Appeals, by outcome: opened, lifted or upheld.',
    labelNames: ['outcome'],
  });
  const latency = metrics.histogram({
    name: 'qtiauth_safety_time_to_action_seconds',
    help: 'Seconds from report creation to the first moderation action or dismissal.',
    buckets: [60, 300, 900, 3_600, 14_400, 86_400],
  });
  const queue = metrics.gauge({
    name: 'qtiauth_safety_queue_depth',
    help: 'Open moderation queue depth, by priority.',
    labelNames: ['priority'],
  });
  return {
    reportReceived: (type, source) => {
      received.inc({ type, source });
    },
    reportClosed: (outcome) => {
      closed.inc({ outcome });
    },
    action: (action) => {
      actions.inc({ action });
    },
    slaBreached: () => {
      sla.inc();
    },
    appeal: (outcome) => {
      appeals.inc({ outcome });
    },
    timeToAction: (seconds) => {
      latency.observe(seconds);
    },
    queueDepth: (priority, count) => {
      queue.set({ priority }, count);
    },
  };
}
