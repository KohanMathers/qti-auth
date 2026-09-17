import { createEvent } from '@qtiauth/bus';
import { loadEventCatalog } from '@qtiauth/events';
import { describe, expect, it } from 'vitest';

import {
  sessionCreatedEvent,
  sessionFlaggedEvent,
  sessionRevokedEvent,
  userCreatedEvent,
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
