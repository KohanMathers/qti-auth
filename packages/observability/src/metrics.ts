import type { QtiauthConfig } from '@qtiauth/config';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export type MetricsConfig = QtiauthConfig['observability']['metrics'];

export const METRIC_PREFIX = 'qtiauth_';

export const FORBIDDEN_LABELS = [
  'user',
  'username',
  'email',
  'ip',
  'ip_address',
  'address',
  'session',
  'token',
  'url',
  'path',
  'query',
  'user_agent',
  'service',
] as const;

export class MetricDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricDefinitionError';
  }
}

export interface MetricDefinition<L extends string> {
  name: string;
  help: string;
  labelNames?: readonly L[];
}

export interface HistogramDefinition<L extends string> extends MetricDefinition<L> {
  buckets?: number[];
}

export interface Metrics {
  registry: Registry;
  counter: <L extends string = never>(definition: MetricDefinition<L>) => Counter<L>;
  gauge: <L extends string = never>(definition: MetricDefinition<L>) => Gauge<L>;
  histogram: <L extends string = never>(definition: HistogramDefinition<L>) => Histogram<L>;
  render: () => Promise<string>;
  contentType: string;
}

export function checkMetricDefinition(definition: MetricDefinition<string>): void {
  if (!/^qtiauth_[a-z][a-z0-9_]*$/.test(definition.name)) {
    throw new MetricDefinitionError(
      `Metric ${definition.name} must be snake_case and start with ${METRIC_PREFIX}`,
    );
  }
  for (const label of definition.labelNames ?? []) {
    const lower = label.toLowerCase();
    if (
      lower === 'id' ||
      lower.endsWith('_id') ||
      (FORBIDDEN_LABELS as readonly string[]).includes(lower)
    ) {
      throw new MetricDefinitionError(
        `Metric ${definition.name} can't have a ${label} label: labels must not hold IDs, emails, IPs or other unbounded values`,
      );
    }
  }
}

export function createMetrics(config: MetricsConfig, service: string): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  if (config.process_metrics) collectDefaultMetrics({ register: registry, prefix: METRIC_PREFIX });

  const base = <L extends string>(definition: MetricDefinition<L>) => {
    checkMetricDefinition(definition);
    return {
      name: definition.name,
      help: definition.help,
      labelNames: definition.labelNames ?? [],
      registers: [registry],
    };
  };

  return {
    registry,
    counter: (definition) => new Counter(base(definition)),
    gauge: (definition) => new Gauge(base(definition)),
    histogram: (definition) =>
      new Histogram({
        ...base(definition),
        ...(definition.buckets === undefined ? {} : { buckets: definition.buckets }),
      }),
    render: () => registry.metrics(),
    contentType: registry.contentType,
  };
}

export async function metricsResponse(metrics: Metrics): Promise<Response> {
  return new Response(await metrics.render(), {
    headers: { 'content-type': metrics.contentType, 'cache-control': 'no-store' },
  });
}
