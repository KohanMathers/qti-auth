import { loadEventCatalog, SAFETY_EVENTS } from '@qtiauth/events';
import { describe, expect, it } from 'vitest';

import {
  flagCreatedEvent,
  reportAcknowledgedEvent,
  reportCreatedEvent,
  reportSlaBreachedEvent,
} from './events.ts';

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

const REPORT_ID = '01234567-89ab-cdef-0123-456789abcdef';

describe('safety event schemas', () => {
  it('validates report.created against the shipped schema', async () => {
    const catalog = await loadEventCatalog();
    const built = reportCreatedEvent(
      REPORT_ID,
      {
        report_id: REPORT_ID,
        type: 'hate',
        subtype: 'targeted_harassment',
        priority: 'normal',
        target: { type: 'user', id: '11111111-2222-3333-4444-555555555555', user_id: null },
        source: { kind: 'user', game_id: null, client_id: null },
        sla_deadline: new Date().toISOString(),
      },
      { type: 'user', id: 'reporter' },
    );
    const result = catalog.validate(envelope(built));
    expect(result.valid).toBe(true);
  });

  it('validates flag.created, sla_breached and acknowledged', async () => {
    const catalog = await loadEventCatalog();
    const results = [
      catalog.validate(
        envelope(
          flagCreatedEvent(
            REPORT_ID,
            {
              report_id: REPORT_ID,
              type: 'hate',
              subtype: 'targeted_harassment',
              priority: 'high',
              target: {
                type: 'content',
                id: 'msg-1',
                user_id: '11111111-2222-3333-4444-555555555555',
              },
              classifier: 'toxicity_v3',
              score: 0.87,
              game_id: 'game-a',
            },
            { type: 'service', id: 'game:game-a' },
          ),
        ),
      ),
      catalog.validate(
        envelope(
          reportSlaBreachedEvent(REPORT_ID, {
            report_id: REPORT_ID,
            type: 'hate',
            priority: 'high',
            sla_deadline: new Date().toISOString(),
            overdue_by_seconds: 42,
          }),
        ),
      ),
      catalog.validate(
        envelope(
          reportAcknowledgedEvent(REPORT_ID, {
            report_id: REPORT_ID,
            recipient_hash: 'a'.repeat(64),
          }),
        ),
      ),
    ];
    for (const result of results) {
      expect(result.valid).toBe(true);
    }
  });

  it('names four safety event types', () => {
    expect(Object.values(SAFETY_EVENTS).sort()).toEqual([
      'qtiauth.safety.flag.created.v1',
      'qtiauth.safety.report.acknowledged.v1',
      'qtiauth.safety.report.created.v1',
      'qtiauth.safety.report.sla_breached.v1',
    ]);
  });
});
