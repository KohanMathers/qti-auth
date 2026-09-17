import { describe, expect, it } from 'vitest';

import { failureWait } from './failures.ts';

describe('failureWait', () => {
  it('grows per failure and caps at max, with no delay on the first attempt', () => {
    const settings = { step: 250, max: 2_000 };
    expect(failureWait(0, settings)).toBe(0);
    expect(failureWait(1, settings)).toBe(250);
    expect(failureWait(8, settings)).toBe(2_000);
    expect(failureWait(40, settings)).toBe(2_000);
  });
});
