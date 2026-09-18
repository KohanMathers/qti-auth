import { describe, expect, it } from 'vitest';

import { EXPORT_SERVICES } from './exports.ts';

describe('data export orchestration', () => {
  it('asks every optional service that can hold personal data', () => {
    expect([...EXPORT_SERVICES].sort()).toEqual(
      ['games', 'notifier', 'oidc', 'safety', 'support'].sort(),
    );
  });
});
