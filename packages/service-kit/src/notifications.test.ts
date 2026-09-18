import { describe, expect, it } from 'vitest';

import { defineNotificationCategories, isNotificationCategory } from './notifications.ts';

describe('defineNotificationCategories', () => {
  it('rejects bad names and missing descriptions', () => {
    expect(() => defineNotificationCategories({ security: { description: 'x' } })).toThrow(
      'dotted lowercase',
    );
    expect(() =>
      defineNotificationCategories({ 'Identity.Security': { description: 'x' } }),
    ).toThrow('dotted lowercase');
    expect(() =>
      defineNotificationCategories({ 'identity.security': { description: '' } }),
    ).toThrow('needs a description');
  });

  it('defaults disableable and audience', () => {
    const categories = defineNotificationCategories({
      'support.ticket_updates': { description: 'Ticket replies' },
      'identity.security': { description: 'Security emails', disableable: false },
      'support.new_tickets': { description: 'New tickets', audience: 'staff' },
    });
    expect(categories['support.ticket_updates']).toMatchObject({
      disableable: true,
      audience: 'user',
    });
    expect(categories['identity.security'].disableable).toBe(false);
    expect(categories['support.new_tickets'].audience).toBe('staff');
    expect(isNotificationCategory('support.ticket_updates')).toBe(true);
    expect(isNotificationCategory('security')).toBe(false);
  });
});
