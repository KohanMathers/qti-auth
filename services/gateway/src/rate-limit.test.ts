import { sections } from '@qtiauth/config';
import { describe, expect, it, vi } from 'vitest';

import {
  createRateLimiter,
  expandPolicy,
  memoryRateLimitStore,
  type RateLimitStore,
  type RateLimitSubject,
  rateLimitHeaders,
} from './rate-limit.ts';

const policies = sections.rate_limits.parse({
  global: { per: 'ip', limit: 100, window: '1m' },
  tight: { per: ['ip', 'account'], limit: 2, window: '1m' },
  emails: { per: 'email', limit: 1, window: '1h', on_store_failure: 'closed' },
  both: { policies: ['tight', 'emails'] },
  users: { per: 'user', limit: 1, window: '1m' },
  slide: { per: 'client', limit: 10, window: '1m' },
});

function subject(overrides: Partial<RateLimitSubject> = {}): RateLimitSubject {
  return {
    ip: '203.0.113.9',
    user: null,
    client: null,
    body: () => Promise.resolve({ email: 'Ann@Example.com ', identifier: 'ann' }),
    ...overrides,
  };
}

function limiter(options: { store?: RateLimitStore; now?: () => number } = {}) {
  const now = options.now ?? (() => 60_000);
  const checked: string[] = [];
  const onStoreError = vi.fn();
  const instance = createRateLimiter({
    policies,
    store: options.store ?? memoryRateLimitStore(now),
    metrics: { checked: (policy, outcome) => checked.push(`${policy}:${outcome}`) },
    onStoreError,
    now,
  });
  return { instance, checked, onStoreError };
}

describe('expandPolicy', () => {
  it('expands groups', () => {
    expect(expandPolicy(policies, 'both')).toEqual(['tight', 'emails']);
    expect(expandPolicy(policies, 'tight')).toEqual(['tight']);
    expect(expandPolicy(policies, 'missing')).toEqual([]);
  });
});

describe('createRateLimiter', () => {
  it('always applies the global policy as well', async () => {
    const { instance, checked } = limiter();
    expect(await instance.check('tight', subject())).toEqual({
      status: 'allowed',
      outcomes: [
        { policy: 'global', limit: 100, window: 60_000, remaining: 99, reset: 60 },
        { policy: 'tight', limit: 2, window: 60_000, remaining: 1, reset: 60 },
      ],
    });
    expect(checked).toEqual(['global:allowed', 'tight:allowed']);
  });

  it('counts combinations of dimensions separately and normalizes body fields', async () => {
    const { instance } = limiter();
    const as = (identifier: string) => subject({ body: () => Promise.resolve({ identifier }) });
    await instance.check('tight', subject());
    await instance.check('tight', subject());
    expect((await instance.check('tight', subject())).status).toBe('limited');
    expect((await instance.check('tight', as('ANN'))).status).toBe('limited');
    expect((await instance.check('tight', as('bob'))).status).toBe('allowed');
    expect((await instance.check('tight', subject({ ip: '198.51.100.1' }))).status).toBe('allowed');
  });

  it('applies every policy in a group', async () => {
    const { instance } = limiter();
    expect((await instance.check('both', subject())).status).toBe('allowed');
    expect(await instance.check('both', subject())).toMatchObject({
      status: 'limited',
      outcome: { policy: 'emails' },
    });
  });

  it('counts per user, falling back to the IP for anonymous callers', async () => {
    const { instance } = limiter();
    expect((await instance.check('users', subject({ user: 'u1' }))).status).toBe('allowed');
    expect((await instance.check('users', subject({ user: 'u1' }))).status).toBe('limited');
    expect((await instance.check('users', subject({ user: 'u2' }))).status).toBe('allowed');
    expect((await instance.check('users', subject())).status).toBe('allowed');
    expect((await instance.check('users', subject())).status).toBe('limited');
  });

  it('slides the window instead of resetting it', async () => {
    let at = 60_000;
    const { instance } = limiter({ now: () => at });
    const game = subject({ client: 'game' });
    for (let i = 0; i < 10; i++) await instance.check('slide', game);
    expect((await instance.check('slide', game)).status).toBe('limited');

    at = 121_000;
    expect((await instance.check('slide', game)).status).toBe('allowed');
    expect(await instance.check('slide', game)).toEqual({
      status: 'limited',
      outcome: { policy: 'slide', limit: 10, window: 60_000, remaining: 0, reset: 59 },
      retryAfter: 5,
    });
    at = 126_001;
    expect((await instance.check('slide', game)).status).toBe('allowed');
  });

  it('fails open or closed per policy when the store is down', async () => {
    const store: RateLimitStore = { increment: () => Promise.reject(new Error('down')) };
    const { instance, checked, onStoreError } = limiter({ store });
    expect(await instance.check('tight', subject())).toEqual({ status: 'allowed', outcomes: [] });
    expect(await instance.check('emails', subject())).toEqual({
      status: 'unavailable',
      policy: 'emails',
    });
    expect(checked).toEqual([
      'global:failed_open',
      'tight:failed_open',
      'global:failed_open',
      'emails:failed_closed',
    ]);
    expect(onStoreError).toHaveBeenCalledWith('emails', expect.any(Error));
  });
});

describe('rateLimitHeaders', () => {
  it('reports the policy closest to its limit', () => {
    expect(
      rateLimitHeaders({
        status: 'allowed',
        outcomes: [
          { policy: 'global', limit: 100, window: 60_000, remaining: 99, reset: 60 },
          { policy: 'tight', limit: 2, window: 900_000, remaining: 1, reset: 30 },
        ],
      }),
    ).toEqual({
      'RateLimit-Limit': '2',
      'RateLimit-Remaining': '1',
      'RateLimit-Reset': '30',
      'RateLimit-Policy': '2;w=900',
    });
    expect(
      rateLimitHeaders({
        status: 'limited',
        outcome: { policy: 'tight', limit: 2, window: 60_000, remaining: 0, reset: 10 },
        retryAfter: 7,
      }),
    ).toMatchObject({ 'RateLimit-Remaining': '0', 'Retry-After': '7' });
    expect(rateLimitHeaders({ status: 'allowed', outcomes: [] })).toEqual({});
  });
});
