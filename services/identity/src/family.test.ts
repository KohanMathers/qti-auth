import { describe, expect, it } from 'vitest';

import { CHILD_LABEL, childLabel, DEFAULT_PARENTAL_CONTROLS, utcDateString } from './family.ts';

describe('family helpers', () => {
  it('labels a missing username as the child', () => {
    expect(childLabel(null)).toBe(CHILD_LABEL);
    expect(childLabel('')).toBe(CHILD_LABEL);
    expect(childLabel('player01')).toBe('player01');
  });

  it('writes a UTC calendar date', () => {
    expect(utcDateString(new Date('2026-09-18T23:59:59.000Z'))).toBe('2026-09-18');
  });

  it('starts game restrictions off', () => {
    expect(DEFAULT_PARENTAL_CONTROLS).toEqual({
      online_play: false,
      in_game_chat: false,
      user_generated_content: false,
      purchases: false,
      daily_playtime_minutes: null,
    });
  });
});
