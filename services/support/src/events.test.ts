import { loadEventCatalog, SUPPORT_EVENTS } from '@qtiauth/events';
import { describe, expect, it } from 'vitest';

import { ticketCreatedEvent, ticketRepliedEvent, ticketStatusChangedEvent } from './events.ts';

interface EventInput {
  type: string;
  actor: { type: string; id: string };
  subject: { type: string; id: string } | null;
  data: object;
}

function envelope(event: EventInput) {
  return {
    event_id: '01H0000000000000000000BEEF',
    type: event.type,
    occurred_at: new Date().toISOString(),
    actor: event.actor,
    subject: event.subject,
    data: event.data,
    trace_id: null,
    span_id: null,
  };
}

const TICKET_ID = '01234567-89ab-cdef-0123-456789abcdef';

describe('support event schemas', () => {
  it('validates ticket events against the shipped schemas', async () => {
    const catalog = await loadEventCatalog();
    const actor = { type: 'user' as const, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    const results = [
      catalog.validate(
        envelope(
          ticketCreatedEvent(
            TICKET_ID,
            {
              ticket_id: TICKET_ID,
              number: 12,
              category: 'account',
              priority: 'normal',
              appeal: false,
              guest: true,
              action_id: null,
            },
            actor,
          ),
        ),
      ),
      catalog.validate(
        envelope(
          ticketRepliedEvent(TICKET_ID, { ticket_id: TICKET_ID, number: 12, staff: true }, actor),
        ),
      ),
      catalog.validate(
        envelope(
          ticketStatusChangedEvent(TICKET_ID, {
            ticket_id: TICKET_ID,
            number: 12,
            from: 'pending',
            to: 'closed',
            auto: true,
          }),
        ),
      ),
    ];
    for (const result of results) {
      expect(result.valid).toBe(true);
    }
  });

  it('names each support event type', () => {
    expect(Object.values(SUPPORT_EVENTS).sort()).toEqual([
      'qtiauth.support.ticket.created.v1',
      'qtiauth.support.ticket.replied.v1',
      'qtiauth.support.ticket.status_changed.v1',
    ]);
  });
});
