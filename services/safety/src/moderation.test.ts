import { describe, expect, it } from 'vitest';

import { durationLabel, type AppliedAction } from './moderation.ts';

function action(overrides: Partial<AppliedAction>): AppliedAction {
  return {
    id: '01234567-89ab-cdef-0123-456789abcdef',
    report_id: '01234567-89ab-cdef-0123-456789abcde0',
    user_id: '11111111-2222-3333-4444-555555555555',
    action: 'warn',
    status: 'applied',
    rule_id: 'hate',
    restrictions: [],
    expires_at: null,
    reason_code: null,
    actor_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    created_at: new Date('2026-09-22T12:00:00.000Z'),
    ...overrides,
  };
}

describe('durationLabel', () => {
  const now = new Date('2026-09-22T12:00:00.000Z');

  it('describes warn, lock, ban and immediate actions', () => {
    expect(durationLabel(action({ action: 'warn' }), now)).toBe('No restriction');
    expect(durationLabel(action({ action: 'ban' }), now)).toBe('Until lifted');
    expect(
      durationLabel(
        action({ action: 'lock', expires_at: new Date('2026-09-23T12:00:00.000Z') }),
        now,
      ),
    ).toBe('Until 2026-09-23T12:00:00.000Z');
    expect(durationLabel(action({ action: 'force_username_reset' }), now)).toBe('Immediate');
  });
});
