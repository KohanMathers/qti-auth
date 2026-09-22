import { loadEventCatalog, SAFETY_EVENTS } from '@qtiauth/events';
import { describe, expect, it } from 'vitest';

import {
  appealCreatedEvent,
  appealResolvedEvent,
  contentRemovalRequestedEvent,
  cseaCaseOpenedEvent,
  cseaEnforcedEvent,
  flagCreatedEvent,
  reportAcknowledgedEvent,
  reportActionedEvent,
  reportCreatedEvent,
  reportDismissedEvent,
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

  it('validates actioned, dismissed, appeal and removal events', async () => {
    const catalog = await loadEventCatalog();
    const actor = { type: 'user' as const, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    const target = {
      type: 'user' as const,
      id: '11111111-2222-3333-4444-555555555555',
      user_id: '11111111-2222-3333-4444-555555555555',
    };
    const actionId = '01234567-89ab-cdef-0123-456789abcdef';
    const results = [
      catalog.validate(
        envelope(
          reportActionedEvent(
            REPORT_ID,
            {
              report_id: REPORT_ID,
              action_id: actionId,
              action: 'restrict',
              rule_id: 'hate',
              target,
              restrictions: ['chat'],
              expires_at: new Date().toISOString(),
            },
            actor,
          ),
        ),
      ),
      catalog.validate(
        envelope(
          reportDismissedEvent(
            REPORT_ID,
            { report_id: REPORT_ID, type: 'hate', priority: 'normal', target },
            actor,
          ),
        ),
      ),
      catalog.validate(
        envelope(
          appealCreatedEvent(
            actionId,
            {
              appeal_id: actionId,
              action_id: actionId,
              action: 'ban',
              user_id: target.id,
              ticket_id: null,
            },
            actor,
          ),
        ),
      ),
      catalog.validate(
        envelope(
          appealResolvedEvent(
            actionId,
            {
              appeal_id: actionId,
              action_id: actionId,
              action: 'ban',
              user_id: target.id,
              outcome: 'lifted',
            },
            actor,
          ),
        ),
      ),
      catalog.validate(
        envelope(
          contentRemovalRequestedEvent(
            REPORT_ID,
            {
              report_id: REPORT_ID,
              action_id: actionId,
              target: { type: 'content', id: 'post-1', user_id: target.id },
              game_id: 'arena',
            },
            actor,
          ),
        ),
      ),
      catalog.validate(envelope(cseaCaseOpenedEvent(REPORT_ID, actor))),
      catalog.validate(
        envelope(
          cseaEnforcedEvent(
            REPORT_ID,
            {
              report_id: REPORT_ID,
              action_id: actionId,
              action: 'lock',
              rule_id: 'protective',
              target,
              expires_at: new Date().toISOString(),
            },
            actor,
          ),
        ),
      ),
    ];
    for (const result of results) {
      expect(result.valid).toBe(true);
    }
  });

  it('names each safety event type', () => {
    expect(Object.values(SAFETY_EVENTS).sort()).toEqual([
      'qtiauth.safety.appeal.created.v1',
      'qtiauth.safety.appeal.resolved.v1',
      'qtiauth.safety.content.removal_requested.v1',
      'qtiauth.safety.csea.case_opened.v1',
      'qtiauth.safety.csea.enforced.v1',
      'qtiauth.safety.flag.created.v1',
      'qtiauth.safety.report.acknowledged.v1',
      'qtiauth.safety.report.actioned.v1',
      'qtiauth.safety.report.created.v1',
      'qtiauth.safety.report.dismissed.v1',
      'qtiauth.safety.report.sla_breached.v1',
    ]);
  });
});
