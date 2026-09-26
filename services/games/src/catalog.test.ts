import { describe, expect, it } from 'vitest';

import { isPublicGame, PUBLIC_GAME_STATUSES } from './catalog.ts';

describe('isPublicGame', () => {
  it('accepts early access and released games', () => {
    expect(isPublicGame('early_access')).toBe(true);
    expect(isPublicGame('released')).toBe(true);
  });

  it('hides drafts, hidden and archived games', () => {
    expect(isPublicGame('draft')).toBe(false);
    expect(isPublicGame('hidden')).toBe(false);
    expect(isPublicGame('archived')).toBe(false);
  });

  it('only lists a fixed set of public statuses', () => {
    expect([...PUBLIC_GAME_STATUSES]).toEqual(['early_access', 'released']);
  });
});
