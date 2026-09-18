import { describe, expect, it } from 'vitest';

import {
  consentExpiresAt,
  guardianEmailProblem,
  MAX_GUARDIAN_EMAIL_CHANGES,
  needsParentalConsent,
  presentConsent,
} from './parental.ts';

describe('parental consent helpers', () => {
  const normalize = (address: string) => address.trim().toLowerCase();

  it('needs a guardian below the consent age, not at it', () => {
    expect(needsParentalConsent(12, 13)).toBe(true);
    expect(needsParentalConsent(13, 13)).toBe(false);
  });

  it('rejects a missing, malformed or same-as-child guardian email', () => {
    expect(guardianEmailProblem(undefined, 'child@example.com', normalize)).toBe('required');
    expect(guardianEmailProblem('  ', 'child@example.com', normalize)).toBe('required');
    expect(guardianEmailProblem('parent', 'child@example.com', normalize)).toBe('invalid');
    expect(guardianEmailProblem('child@example.com', 'child@example.com', normalize)).toBe(
      'same_as_child',
    );
    expect(guardianEmailProblem('parent@example.com', 'child@example.com', normalize)).toBe(
      undefined,
    );
  });

  it('counts remaining guardian email changes from the spec’s max of 3', () => {
    const requested = new Date('2026-09-01T00:00:00.000Z');
    expect(
      presentConsent(
        {
          id: '1',
          user_id: '2',
          guardian_email: 'parent@example.com',
          guardian_email_normalized: 'parent@example.com',
          guardian_date_of_birth: null,
          email_changes: 1,
          status: 'pending',
          requested_at: requested,
          decided_at: null,
        },
        14 * 86_400_000,
      ),
    ).toEqual({
      guardian_email: 'parent@example.com',
      email_changes_remaining: MAX_GUARDIAN_EMAIL_CHANGES - 1,
      expires_at: consentExpiresAt(requested, 14 * 86_400_000).toISOString(),
    });
  });
});
