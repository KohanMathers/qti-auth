import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { duration, parseDuration, requiredDuration } from './duration.ts';

describe('parseDuration', () => {
  it.each([
    ['250ms', 250],
    ['30s', 30_000],
    ['15m', 900_000],
    ['12h', 43_200_000],
    ['7d', 604_800_000],
    ['2w', 1_209_600_000],
  ])('parses %s', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it.each(['', '7', 'd', '7 d', '7days', '1.5h', '-1s', '0s'])('rejects %j', (input) => {
    expect(parseDuration(input)).toBeUndefined();
  });
});

describe('duration', () => {
  const schema = z.object({ ttl: duration('7d', 'TTL.') });

  it('applies and parses the default', () => {
    expect(schema.parse({})).toEqual({ ttl: 604_800_000 });
  });

  it('rejects zero', () => {
    expect(schema.safeParse({ ttl: '0s' }).error?.issues[0]?.message).toBe(
      'Duration must be positive',
    );
  });
});

describe('requiredDuration', () => {
  const schema = z.object({ window: requiredDuration('Window.') });

  it('has no default', () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.parse({ window: '15m' })).toEqual({ window: 900_000 });
  });
});
