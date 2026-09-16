import { describe, expect, it } from 'vitest';

import { newEventId } from './event-id.ts';

describe('newEventId', () => {
  it('returns a 26-character ULID', () => {
    expect(newEventId()).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it('encodes the time so ids sort by creation', () => {
    expect(newEventId(0).slice(0, 10)).toBe('0000000000');
    expect(newEventId(Date.UTC(2026, 8, 16)) < newEventId(Date.UTC(2026, 8, 17))).toBe(true);
  });

  it('is unique', () => {
    const now = Date.now();
    const ids = new Set(Array.from({ length: 1000 }, () => newEventId(now)));
    expect(ids.size).toBe(1000);
  });
});
