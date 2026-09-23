import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { staffTicketUrl, ticketUrl } from './origin.ts';

describe('support origins', () => {
  const surfaces = sections.surfaces.parse({
    account: { hosts: ['account.example.com'] },
    support: { hosts: ['account.example.com'], base_path: '/support' },
  });

  it('builds user and staff ticket links from the support and account surfaces', () => {
    expect(ticketUrl(surfaces, 'ticket-1')).toBe(
      'https://account.example.com/support/tickets/ticket-1',
    );
    expect(staffTicketUrl(surfaces, 'ticket-1')).toBe(
      'https://account.example.com/admin/support/tickets/ticket-1',
    );
  });
});
