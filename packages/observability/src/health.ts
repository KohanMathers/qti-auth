import { untraced } from './spans.ts';

export type HealthCheck = () => Promise<void>;
export type CheckStatus = 'ok' | 'failed' | 'timeout';

export interface Liveness {
  status: 'ok';
  service: string;
}

export interface CheckResult {
  status: CheckStatus;
  duration_ms: number;
}

export interface Readiness {
  status: 'ok' | 'unavailable';
  service: string;
  checks: Record<string, CheckResult>;
}

export interface ReadinessOptions {
  timeout: number;
  onError?: (check: string, error: unknown) => void;
}

const TIMED_OUT = Symbol('timeout');

export function liveness(service: string): Liveness {
  return { status: 'ok', service };
}

async function runCheck(
  name: string,
  check: HealthCheck,
  options: ReadinessOptions,
): Promise<CheckResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(resolve, options.timeout, TIMED_OUT);
  });
  try {
    const outcome = await Promise.race([untraced(check), deadline]);
    return { status: outcome === TIMED_OUT ? 'timeout' : 'ok', duration_ms: elapsed() };
  } catch (error) {
    options.onError?.(name, error);
    return { status: 'failed', duration_ms: elapsed() };
  } finally {
    clearTimeout(timer);
  }
}

export async function readiness(
  service: string,
  checks: Record<string, HealthCheck>,
  options: ReadinessOptions,
): Promise<Readiness> {
  const results = await Promise.all(
    Object.entries(checks).map(
      async ([name, check]) => [name, await runCheck(name, check, options)] as const,
    ),
  );
  return {
    status: results.every(([, result]) => result.status === 'ok') ? 'ok' : 'unavailable',
    service,
    checks: Object.fromEntries(results),
  };
}

export function healthResponse(health: Liveness | Readiness): Response {
  return Response.json(health, {
    status: health.status === 'ok' ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
