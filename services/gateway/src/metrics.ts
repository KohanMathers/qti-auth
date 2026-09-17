import type { Metrics } from '@qtiauth/observability';

export type UpstreamErrorReason = 'unreachable' | 'timeout';

export interface GatewayMetrics {
  request: (
    labels: { surface: string; route: string; method: string; status: number },
    seconds: number,
    requestBytes: number,
    responseBytes: number | null,
  ) => void;
  upstreamError: (upstream: string, reason: UpstreamErrorReason) => void;
  keyRotated: () => void;
  keyLoaded: (createdAt: number) => void;
}

const SIZE_BUCKETS = [100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000];

export function prometheusGatewayMetrics(metrics: Metrics): GatewayMetrics {
  const requests = metrics.counter({
    name: 'qtiauth_gateway_requests_total',
    help: 'Public requests, by surface, route template, method and status.',
    labelNames: ['surface', 'route', 'method', 'status'],
  });
  const duration = metrics.histogram({
    name: 'qtiauth_gateway_request_duration_seconds',
    help: 'Public request latency, including the service, by surface, route template and method.',
    labelNames: ['surface', 'route', 'method'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  });
  const requestSize = metrics.histogram({
    name: 'qtiauth_gateway_request_size_bytes',
    help: 'Request body sizes, by surface and route template.',
    labelNames: ['surface', 'route'],
    buckets: SIZE_BUCKETS,
  });
  const responseSize = metrics.histogram({
    name: 'qtiauth_gateway_response_size_bytes',
    help: 'Response body sizes where known, by surface and route template.',
    labelNames: ['surface', 'route'],
    buckets: SIZE_BUCKETS,
  });
  const upstreamErrors = metrics.counter({
    name: 'qtiauth_gateway_upstream_errors_total',
    help: 'Requests the gateway could not complete against a service, by service and reason.',
    labelNames: ['upstream', 'reason'],
  });
  const rotations = metrics.counter({
    name: 'qtiauth_gateway_identity_key_rotations_total',
    help: 'Identity token signing keys rotated by this replica.',
  });
  const keyCreated = metrics.gauge({
    name: 'qtiauth_gateway_identity_key_created_timestamp_seconds',
    help: 'When the key currently signing internal identity tokens was created, as a Unix timestamp.',
  });

  return {
    request: ({ surface, route, method, status }, seconds, requestBytes, responseBytes) => {
      requests.inc({ surface, route, method, status: String(status) });
      duration.observe({ surface, route, method }, seconds);
      requestSize.observe({ surface, route }, requestBytes);
      if (responseBytes !== null) responseSize.observe({ surface, route }, responseBytes);
    },
    upstreamError: (upstream, reason) => {
      upstreamErrors.inc({ upstream, reason });
    },
    keyRotated: () => {
      rotations.inc();
    },
    keyLoaded: (createdAt) => {
      keyCreated.set(createdAt / 1000);
    },
  };
}
