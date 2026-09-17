import { describe, expect, it } from 'vitest';

import {
  ageAssuranceProvider,
  assuranceRequiredFor,
  SELF_DECLARED_PROVIDER,
  selfDeclaredProvider,
} from './age-assurance.ts';

describe('self_declared age assurance', () => {
  const now = new Date('2026-09-17T00:05:00Z');

  it('completes immediately with no vendor reference', async () => {
    const provider = selfDeclaredProvider();
    expect(provider.id).toBe(SELF_DECLARED_PROVIDER);
    expect(provider.strength).toBe('self_declared');
    const begun = await provider.begin({ id: 'user-1' }, { now });
    expect(begun).toEqual({
      status: 'completed',
      result: {
        provider: 'self_declared',
        strength: 'self_declared',
        vendor_reference: null,
        completed_at: now,
      },
    });
    await expect(provider.complete({ id: 'user-1' }, {}, { now })).resolves.toEqual(
      begun.status === 'completed' ? begun.result : undefined,
    );
  });

  it('is the only shipped provider', () => {
    expect(ageAssuranceProvider('self_declared').id).toBe('self_declared');
    expect(() => ageAssuranceProvider('yoti')).toThrow('Unknown age assurance provider');
  });

  it('treats claim_adult_band as required only when listed', () => {
    expect(assuranceRequiredFor('claim_adult_band', [])).toBe(false);
    expect(assuranceRequiredFor('claim_adult_band', ['claim_adult_band'])).toBe(true);
  });
});
