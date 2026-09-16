import { context, propagation, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type SpanProcessor,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { QtiauthConfig } from '@qtiauth/config';

export type TracingConfig = QtiauthConfig['observability']['tracing'];

export const SERVICE_NAMESPACE = 'qtiauth';

export interface TracingOptions {
  spanProcessors?: SpanProcessor[];
}

export interface Tracing {
  flush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export function startTracing(
  config: TracingConfig,
  service: string,
  options: TracingOptions = {},
): Tracing {
  const ratio = new TraceIdRatioBasedSampler(config.sample_ratio);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': service,
      'service.namespace': SERVICE_NAMESPACE,
    }),
    sampler: new ParentBasedSampler({ root: ratio, remoteParentNotSampled: ratio }),
    spanProcessors:
      options.spanProcessors ??
      (config.enabled
        ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: config.endpoint }))]
        : []),
  });
  provider.register();

  return {
    flush: () => provider.forceFlush(),
    shutdown: async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
