import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { retryDelay } from './consumer.ts';

describe('retryDelay', () => {
  it('doubles from retry_delay up to max_retry_delay', () => {
    const { consumers } = sections.bus.parse({
      consumers: { retry_delay: '1s', max_retry_delay: '10s' },
    });
    expect([1, 2, 3, 4, 5, 20].map((attempt) => retryDelay(attempt, consumers))).toEqual([
      1_000, 2_000, 4_000, 8_000, 10_000, 10_000,
    ]);
  });
});
