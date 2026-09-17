import { createHash } from 'node:crypto';

import type { QtiauthConfig, RateLimitDimension, RateLimitPolicy } from '@qtiauth/config';
import type { Metrics } from '@qtiauth/observability';
import { KEY_PREFIX, type Valkey } from '@qtiauth/valkey';

export type RateLimitsConfig = QtiauthConfig['rate_limits'];

export const GLOBAL_POLICY = 'global';

export interface WindowKeys {
  current: string;
  previous: string;
}

export interface WindowCounts {
  allowed: boolean;
  current: number;
  previous: number;
}

export interface RateLimitStore {
  increment: (
    keys: WindowKeys,
    limit: number,
    previousWeight: number,
    ttl: number,
  ) => Promise<WindowCounts>;
}

export interface RateLimitSubject {
  ip: string;
  user: string | null;
  client: string | null;
  body: () => Promise<unknown>;
}

export interface PolicyOutcome {
  policy: string;
  limit: number;
  window: number;
  remaining: number;
  reset: number;
}

export type RateLimitResult =
  | { status: 'allowed'; outcomes: PolicyOutcome[] }
  | { status: 'limited'; outcome: PolicyOutcome; retryAfter: number }
  | { status: 'unavailable'; policy: string };

export type RateLimitCheckOutcome = 'allowed' | 'limited' | 'failed_open' | 'failed_closed';

export interface RateLimitMetrics {
  checked: (policy: string, outcome: RateLimitCheckOutcome) => void;
}

export interface RateLimiterOptions {
  policies: RateLimitsConfig;
  store: RateLimitStore;
  metrics: RateLimitMetrics;
  onStoreError: (policy: string, error: unknown) => void;
  now?: () => number;
}

export interface RateLimiter {
  policies: ReadonlySet<string>;
  check: (policy: string, subject: RateLimitSubject) => Promise<RateLimitResult>;
}

const SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
local limit = tonumber(ARGV[1])
if math.floor(previous * tonumber(ARGV[2])) + current >= limit then
  return {0, current, previous}
end
current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
return {1, current, previous}
`;

interface ScriptClient {
  qtiauthRateLimit: (
    current: string,
    previous: string,
    limit: number,
    weight: string,
    ttl: number,
  ) => Promise<[number, number, number]>;
}

export function prometheusRateLimitMetrics(metrics: Metrics): RateLimitMetrics {
  const checks = metrics.counter({
    name: 'qtiauth_gateway_rate_limit_checks_total',
    help: 'Rate-limit checks, by policy and outcome (allowed, limited, failed_open, failed_closed).',
    labelNames: ['policy', 'outcome'],
  });
  return {
    checked: (policy, outcome) => {
      checks.inc({ policy, outcome });
    },
  };
}

export function valkeyRateLimitStore(client: Valkey): RateLimitStore {
  client.defineCommand('qtiauthRateLimit', { numberOfKeys: 2, lua: SCRIPT });
  const scripted = client as unknown as ScriptClient;
  return {
    increment: async (keys, limit, previousWeight, ttl) => {
      const [allowed, current, previous] = await scripted.qtiauthRateLimit(
        keys.current,
        keys.previous,
        limit,
        previousWeight.toFixed(6),
        ttl,
      );
      return { allowed: allowed === 1, current, previous };
    },
  };
}

export function memoryRateLimitStore(now: () => number = Date.now): RateLimitStore {
  const counters = new Map<string, { count: number; expiresAt: number }>();
  const read = (key: string) => {
    const entry = counters.get(key);
    return entry && entry.expiresAt > now() ? entry : undefined;
  };
  return {
    increment: (keys, limit, previousWeight, ttl) => {
      const entry = read(keys.current);
      const current = entry?.count ?? 0;
      const previous = read(keys.previous)?.count ?? 0;
      if (Math.floor(previous * previousWeight) + current >= limit) {
        return Promise.resolve({ allowed: false, current, previous });
      }
      counters.set(keys.current, {
        count: current + 1,
        expiresAt: entry?.expiresAt ?? now() + ttl,
      });
      return Promise.resolve({ allowed: true, current: current + 1, previous });
    },
  };
}

function normalize(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.normalize('NFKC').trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

function field(body: unknown, names: readonly string[]): string | null {
  if (typeof body !== 'object' || body === null) return null;
  for (const name of names) {
    const value = normalize((body as Record<string, unknown>)[name]);
    if (value !== null) return value;
  }
  return null;
}

async function dimensionValue(
  dimension: RateLimitDimension,
  subject: RateLimitSubject,
): Promise<string> {
  switch (dimension) {
    case 'ip':
      return `ip:${subject.ip}`;
    case 'user':
      return subject.user === null ? `ip:${subject.ip}` : `user:${subject.user}`;
    case 'client':
      return subject.client === null ? `ip:${subject.ip}` : `client:${subject.client}`;
    case 'email':
      return `email:${field(await subject.body(), ['email']) ?? ''}`;
    case 'account':
      return `account:${field(await subject.body(), ['identifier', 'email', 'username']) ?? ''}`;
  }
}

export function retryAfterMs(
  counts: WindowCounts,
  limit: number,
  window: number,
  elapsed: number,
): number {
  if (counts.current < limit) {
    return Math.max(0, window * (1 - (limit - counts.current) / counts.previous) - elapsed);
  }
  return window - elapsed + window * (1 - limit / counts.current);
}

export function expandPolicy(policies: RateLimitsConfig, name: string): string[] {
  const policy = policies[name];
  if (policy === undefined) return [];
  return 'policies' in policy ? policy.policies : [name];
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const { policies, store, metrics } = options;

  const checkOne = async (
    name: string,
    policy: RateLimitPolicy,
    subject: RateLimitSubject,
  ): Promise<RateLimitResult> => {
    const values = await Promise.all(policy.per.map((dim) => dimensionValue(dim, subject)));
    const hash = createHash('sha256')
      .update(JSON.stringify(values))
      .digest('base64url')
      .slice(0, 32);
    const at = now();
    const index = Math.floor(at / policy.window);
    const elapsed = at - index * policy.window;
    const base = `${KEY_PREFIX}ratelimit:{${name}:${hash}}`;
    const weight = 1 - elapsed / policy.window;

    let counts: WindowCounts;
    try {
      counts = await store.increment(
        { current: `${base}:${String(index)}`, previous: `${base}:${String(index - 1)}` },
        policy.limit,
        weight,
        policy.window * 2,
      );
    } catch (error) {
      options.onStoreError(name, error);
      if (policy.on_store_failure === 'closed') {
        metrics.checked(name, 'failed_closed');
        return { status: 'unavailable', policy: name };
      }
      metrics.checked(name, 'failed_open');
      return { status: 'allowed', outcomes: [] };
    }

    const used = Math.floor(counts.previous * weight) + counts.current;
    const outcome: PolicyOutcome = {
      policy: name,
      limit: policy.limit,
      window: policy.window,
      remaining: Math.max(0, policy.limit - used),
      reset: Math.ceil((policy.window - elapsed) / 1000),
    };
    if (!counts.allowed) {
      metrics.checked(name, 'limited');
      const wait = retryAfterMs(counts, policy.limit, policy.window, elapsed);
      return {
        status: 'limited',
        outcome: { ...outcome, remaining: 0 },
        retryAfter: Math.max(1, Math.ceil(wait / 1000)),
      };
    }
    metrics.checked(name, 'allowed');
    return { status: 'allowed', outcomes: [outcome] };
  };

  return {
    policies: new Set(Object.keys(policies)),
    check: async (name, subject) => {
      const outcomes: PolicyOutcome[] = [];
      for (const policyName of new Set([GLOBAL_POLICY, ...expandPolicy(policies, name)])) {
        const policy = policies[policyName];
        if (policy === undefined || 'policies' in policy) {
          return { status: 'unavailable', policy: policyName };
        }
        const result = await checkOne(policyName, policy, subject);
        if (result.status !== 'allowed') return result;
        outcomes.push(...result.outcomes);
      }
      return { status: 'allowed', outcomes };
    },
  };
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  let outcome: PolicyOutcome | undefined;
  if (result.status === 'limited') outcome = result.outcome;
  else if (result.status === 'allowed') {
    outcome = [...result.outcomes].sort((a, b) => a.remaining - b.remaining)[0];
  }
  if (!outcome) return {};
  return {
    'RateLimit-Limit': String(outcome.limit),
    'RateLimit-Remaining': String(outcome.remaining),
    'RateLimit-Reset': String(outcome.reset),
    'RateLimit-Policy': `${String(outcome.limit)};w=${String(Math.ceil(outcome.window / 1000))}`,
    ...(result.status === 'limited' ? { 'Retry-After': String(result.retryAfter) } : {}),
  };
}
