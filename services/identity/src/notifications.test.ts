import { describe, expect, it } from 'vitest';

import { IDENTITY_NOTIFICATIONS } from './notifications.ts';

describe('IDENTITY_NOTIFICATIONS', () => {
  it('keeps security and legal on, and marks staff alerts as staff-only', () => {
    expect(IDENTITY_NOTIFICATIONS['identity.security']).toMatchObject({ disableable: false });
    expect(IDENTITY_NOTIFICATIONS['identity.legal']).toMatchObject({ disableable: false });
    expect(IDENTITY_NOTIFICATIONS['support.ticket_updates']).toMatchObject({
      disableable: true,
      audience: 'user',
    });
    expect(IDENTITY_NOTIFICATIONS['support.new_tickets'].audience).toBe('staff');
    expect(IDENTITY_NOTIFICATIONS['safety.high_priority_reports'].audience).toBe('staff');
  });
});
