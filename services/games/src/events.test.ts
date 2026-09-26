import { GAME_TRUST_LEVELS, GAMES_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { describe, expect, it } from 'vitest';

import { ENTITLEMENT_TRUST, entitlementGrantedEvent, entitlementRevokedEvent } from './events.ts';

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

const ID = '01234567-89ab-4def-8123-456789abcdef';

describe('games event schemas', () => {
  it('validates entitlement events against the shipped schemas', async () => {
    const catalog = await loadEventCatalog();
    const actor = { type: 'user' as const, id: ID };
    const granted = entitlementGrantedEvent(
      ID,
      {
        entitlement_id: ID,
        user_id: ID,
        game_id: ID,
        product_id: ID,
        source: 'admin_grant',
        trust: ENTITLEMENT_TRUST,
        expires_at: '2026-10-01T00:00:00.000Z',
      },
      actor,
    );
    const revoked = entitlementRevokedEvent(
      ID,
      {
        entitlement_id: ID,
        user_id: ID,
        game_id: ID,
        product_id: ID,
        source: 'api',
        trust: ENTITLEMENT_TRUST,
        reason: 'expired',
      },
      { type: 'system', id: 'games' },
    );
    expect(catalog.validate(envelope(granted)).valid).toBe(true);
    expect(catalog.validate(envelope(revoked)).valid).toBe(true);
    expect(GAMES_EVENTS.entitlementGranted).toBe(granted.type);
  });

  it('never emits entitlement events at player trust', () => {
    expect(GAME_TRUST_LEVELS).toContain('player');
    expect(ENTITLEMENT_TRUST).toBe('game');
    const granted = entitlementGrantedEvent(
      ID,
      {
        entitlement_id: ID,
        user_id: ID,
        game_id: ID,
        product_id: ID,
        source: 'admin_grant',
        trust: ENTITLEMENT_TRUST,
        expires_at: null,
      },
      { type: 'system', id: 'games' },
    );
    expect(granted.data.trust).toBe('game');
  });
});
