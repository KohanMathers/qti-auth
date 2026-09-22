import { describe, expect, it } from 'vitest';

import { activeRestrictionNames } from './restrictions.ts';

describe('activeRestrictionNames', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');

  it('keeps unrestricted names and those that have not expired, sorted', () => {
    expect(
      activeRestrictionNames(
        [
          { name: 'ugc', expires_at: new Date('2026-09-22T11:00:00.000Z') },
          { name: 'chat', expires_at: null },
          { name: 'username_change', expires_at: new Date('2026-09-22T13:00:00.000Z') },
        ],
        now,
      ),
    ).toEqual(['chat', 'username_change']);
  });
});
