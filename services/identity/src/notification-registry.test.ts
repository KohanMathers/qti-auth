import { defineNotificationCategories } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import { mergeDeclaredNotifications } from './notification-registry.ts';
import { IDENTITY_NOTIFICATIONS } from './notifications.ts';

describe('mergeDeclaredNotifications', () => {
  it('keeps the local catalog and adds categories announced by other services', () => {
    const listed = mergeDeclaredNotifications('identity', IDENTITY_NOTIFICATIONS, [
      {
        name: 'support',
        version: '1.0.0',
        instances: 1,
        manifest: {
          service: 'support',
          version: '1.0.0',
          routes: [],
          permissions: [],
          notifications: [
            {
              name: 'support.ticket_updates',
              description: 'From support',
              disableable: true,
              audience: 'user',
            },
            {
              name: 'support.macros',
              description: 'Macro suggestions',
              disableable: true,
              audience: 'staff',
            },
          ],
        },
      },
    ]);
    expect(listed.map((item) => item.name)).toEqual([
      'identity.legal',
      'identity.security',
      'safety.high_priority_reports',
      'support.macros',
      'support.new_tickets',
      'support.ticket_updates',
    ]);
    expect(listed.find((item) => item.name === 'support.ticket_updates')).toMatchObject({
      description: IDENTITY_NOTIFICATIONS['support.ticket_updates'].description,
      service: 'identity',
    });
    expect(listed.find((item) => item.name === 'support.macros')).toMatchObject({
      service: 'support',
      audience: 'staff',
    });
  });

  it('accepts an empty own catalog', () => {
    expect(mergeDeclaredNotifications('identity', defineNotificationCategories({}), [])).toEqual(
      [],
    );
  });
});
