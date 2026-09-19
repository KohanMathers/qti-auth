import { createEvent } from '@qtiauth/bus';
import { loadEventCatalog } from '@qtiauth/events';
import { describe, expect, it } from 'vitest';

import { authorizationGrantedEvent, refreshReuseDetectedEvent } from './events.ts';

const USER_ID = '0199a0e0-0000-7000-8000-000000000001';

describe('oidc events', () => {
  it('match their schemas in packages/events', async () => {
    const catalog = await loadEventCatalog();
    const events = [
      createEvent(
        authorizationGrantedEvent(
          USER_ID,
          { client_id: 'game', client_type: 'public', scopes: ['openid'] },
          { type: 'user', id: USER_ID },
        ),
      ),
      createEvent(
        refreshReuseDetectedEvent(USER_ID, {
          client_id: 'game',
          family_id: '0199a0e0-0000-7000-8000-000000000002',
        }),
      ),
    ];
    for (const event of events) {
      expect(catalog.validate(event).valid, event.type).toBe(true);
    }
  });
});
