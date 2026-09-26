import { describe, expect, it } from 'vitest';

import { entitlementGrantedEvent, entitlementRevokedEvent, SYSTEM_ACTOR } from './events.ts';

const ID = '01234567-89ab-4def-8123-456789abcdef';

describe('entitlement events', () => {
  it('sets the entitlement as the subject on both event types', () => {
    const granted = entitlementGrantedEvent(
      ID,
      {
        entitlement_id: ID,
        user_id: ID,
        game_id: ID,
        product_id: ID,
        source: 'api',
        expires_at: null,
      },
      { type: 'user', id: ID },
    );
    const revoked = entitlementRevokedEvent(
      ID,
      {
        entitlement_id: ID,
        user_id: ID,
        game_id: ID,
        product_id: ID,
        source: 'api',
        reason: 'expired',
      },
      SYSTEM_ACTOR,
    );
    expect(granted.subject).toEqual({ type: 'entitlement', id: ID });
    expect(revoked.subject).toEqual({ type: 'entitlement', id: ID });
    expect(revoked.actor).toEqual({ type: 'system', id: 'games' });
  });
});
