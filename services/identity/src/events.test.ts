import { createEvent } from '@qtiauth/bus';
import { loadEventCatalog } from '@qtiauth/events';
import { describe, expect, it } from 'vitest';

import {
  auditRecordedEvent,
  sessionCreatedEvent,
  sessionFlaggedEvent,
  sessionRevokedEvent,
  userAgeBandChangedEvent,
  userBannedEvent,
  userCreatedEvent,
  userDeletedEvent,
  userLockedEvent,
  userRestrictedEvent,
  userUnbannedEvent,
  userUnlockedEvent,
  userUpdatedEvent,
  legalVersionPublishedEvent,
  parentalConsentGrantedEvent,
  parentalConsentRemovalRequestedEvent,
  parentalConsentRequestedEvent,
  parentalConsentRevokedEvent,
} from './events.ts';

const USER_ID = '0199a0e0-0000-7000-8000-000000000001';
const SESSION_ID = '0199a0e0-0000-7000-8000-000000000002';

describe('identity events', () => {
  it('match their schemas in packages/events', async () => {
    const catalog = await loadEventCatalog();
    const events = [
      createEvent(
        userCreatedEvent(USER_ID, {
          signup_method: 'magic_link',
          account_state: 'active',
          age_band: 'adult',
        }),
      ),
      createEvent(
        sessionCreatedEvent(SESSION_ID, {
          user_id: USER_ID,
          auth_method: 'magic_link',
          amr: ['email'],
          acr: 'aal1',
        }),
      ),
      createEvent(
        sessionRevokedEvent({ session_id: SESSION_ID, user_id: USER_ID, reason: 'evicted' }),
      ),
      createEvent(
        sessionFlaggedEvent({
          session_id: SESSION_ID,
          user_id: USER_ID,
          reason: 'country_change',
          trust_level: 'challenge',
          acr: 'aal0',
        }),
      ),
      createEvent(
        sessionFlaggedEvent({
          session_id: SESSION_ID,
          user_id: USER_ID,
          reason: 'staff',
          trust_level: 'challenge',
          acr: 'aal0',
        }),
      ),
      createEvent(userDeletedEvent(USER_ID, { held: false })),
      createEvent(userUpdatedEvent(USER_ID, { fields: ['username'] })),
      createEvent(
        userAgeBandChangedEvent(USER_ID, {
          previous_age_band: '16_to_17',
          age_band: 'adult',
        }),
      ),
      createEvent(
        legalVersionPublishedEvent({
          id: 'terms',
          version: '2026-10-01',
          effective_at: '2026-10-01T00:00:00.000Z',
          material: true,
          summary: 'We added passkeys.',
        }),
      ),
      createEvent(
        parentalConsentRequestedEvent(USER_ID, { expires_at: '2026-10-01T00:00:00.000Z' }),
      ),
      createEvent(parentalConsentGrantedEvent(USER_ID)),
      createEvent(parentalConsentRevokedEvent(USER_ID)),
      createEvent(parentalConsentRemovalRequestedEvent(USER_ID)),
      createEvent(
        userBannedEvent(USER_ID, { reason: 'Repeated abuse' }, { type: 'user', id: USER_ID }),
      ),
      createEvent(
        userUnbannedEvent(USER_ID, { reason: 'Appeal upheld' }, { type: 'user', id: USER_ID }),
      ),
      createEvent(
        userLockedEvent(
          USER_ID,
          { reason: 'Investigation', expires_at: '2026-09-19T12:00:00.000Z' },
          { type: 'user', id: USER_ID },
        ),
      ),
      createEvent(
        userUnlockedEvent(USER_ID, { reason: 'expired' }, { type: 'system', id: 'identity' }),
      ),
      createEvent(
        userRestrictedEvent(
          USER_ID,
          { restrictions: ['chat', 'username_change'], reason: 'hate' },
          { type: 'user', id: USER_ID },
        ),
      ),
      createEvent(
        userRestrictedEvent(USER_ID, { restrictions: [] }, { type: 'system', id: 'identity' }),
      ),
      createEvent(
        auditRecordedEvent(
          { type: 'user', id: USER_ID },
          { action: 'role.updated', target_type: 'role', target_id: USER_ID },
        ),
      ),
    ];
    for (const event of events) {
      expect(catalog.validate(event), event.type).toEqual({ valid: true, event });
    }
  });

  it('name the session in revocations, so the gateway drops it from its cache', () => {
    expect(
      sessionRevokedEvent({ session_id: SESSION_ID, user_id: USER_ID, reason: 'logout' }),
    ).toMatchObject({
      subject: { type: 'session', id: SESSION_ID },
      data: { session_id: SESSION_ID, user_id: USER_ID },
    });
  });
});
