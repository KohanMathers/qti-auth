import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { createRateLimiter, memoryRateLimitStore, type RateLimitSubject } from './rate-limit.ts';

const policies = sections.rate_limits.parse({
  global: { per: 'ip', limit: 300, window: '1m' },
  auth_password: { per: ['ip', 'account'], limit: 10, window: '15m' },
  magic_link_ip: { per: 'ip', limit: 10, window: '1h' },
});

interface LoadOptions {
  policy: string;
  requests: number;
  subjects: number;
  workers: number;
}

async function runLoad(options: LoadOptions): Promise<{
  allowed: number;
  limited: number;
  headerBudget: number;
}> {
  const at = 60_000;
  const now = () => at;
  const limiter = createRateLimiter({
    policies,
    store: memoryRateLimitStore(now),
    metrics: { checked: () => undefined },
    onStoreError: () => undefined,
    now,
  });
  const subjects: RateLimitSubject[] = Array.from({ length: options.subjects }, (_, i) => ({
    ip: `203.0.113.${String(i % 254)}`,
    user: null,
    client: null,
    body: () => Promise.resolve({ identifier: `user-${String(i)}` }),
  }));
  let allowed = 0;
  let limited = 0;
  let headerBudget = 0;
  const perWorker = Math.ceil(options.requests / options.workers);
  const worker = async (offset: number) => {
    for (let i = 0; i < perWorker; i++) {
      const subject = subjects[(offset + i) % subjects.length];
      if (subject === undefined) continue;
      const result = await limiter.check(options.policy, subject);
      if (result.status === 'allowed') {
        allowed += 1;
        for (const outcome of result.outcomes) {
          if (outcome.policy === options.policy) headerBudget += outcome.remaining;
        }
      } else if (result.status === 'limited') {
        limited += 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: options.workers }, (_, offset) => worker(offset * perWorker)),
  );
  return { allowed, limited, headerBudget };
}

describe('gateway rate-limit load', () => {
  it('caps a single subject at its policy limit even under 1000 parallel requests', async () => {
    const requests = 1000;
    const outcome = await runLoad({
      policy: 'auth_password',
      requests,
      subjects: 1,
      workers: 50,
    });
    expect(outcome.allowed).toBe(10);
    expect(outcome.limited).toBe(requests - 10);
  });

  it('scales linearly with distinct subjects, so a shared limit does not leak', async () => {
    const subjects = 50;
    const perSubject = 25;
    const outcome = await runLoad({
      policy: 'auth_password',
      requests: subjects * perSubject,
      subjects,
      workers: subjects,
    });
    expect(outcome.allowed).toBe(subjects * 10);
    expect(outcome.limited).toBe(subjects * perSubject - subjects * 10);
  });

  it('holds the global cap over a burst that would otherwise flood a single IP', async () => {
    const outcome = await runLoad({
      policy: 'global',
      requests: 5000,
      subjects: 1,
      workers: 100,
    });
    expect(outcome.allowed).toBe(300);
    expect(outcome.limited).toBe(4700);
  });

  it('has the reported remaining budget line up with the number of successes', async () => {
    const outcome = await runLoad({
      policy: 'magic_link_ip',
      requests: 30,
      subjects: 1,
      workers: 5,
    });
    expect(outcome.allowed).toBe(10);
    expect(outcome.headerBudget).toBe(45);
  });
});
