import { describe, expect, it } from 'vitest';

import { formatConnectedApps } from './family-apps.ts';

describe('formatConnectedApps', () => {
  it('names connected apps for the weekly email', () => {
    expect(formatConnectedApps([])).toBe('None this week');
    expect(
      formatConnectedApps([
        { client_id: 'studio', name: 'Studio', granted_at: '2026-09-21T00:00:00.000Z' },
        { client_id: 'game', name: 'Game', granted_at: '2026-09-21T00:00:00.000Z' },
      ]),
    ).toBe('Studio, Game');
  });
});
