import { createEvent } from '@qtiauth/bus';
import { loadEventCatalog } from '@qtiauth/events';
import { describe, expect, it } from 'vitest';

import {
  authorizationGrantedEvent,
  authorizationGuardianRequestedEvent,
  clientAuthorizedEvent,
  clientCreatedEvent,
  refreshReuseDetectedEvent,
} from './events.ts';

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
        authorizationGuardianRequestedEvent(USER_ID, {
          client_id: 'studio',
          client_name: 'Studio',
          client_type: 'confidential',
          scopes: ['openid'],
          request_id: USER_ID,
        }),
      ),
      createEvent(
        clientAuthorizedEvent(
          USER_ID,
          {
            client_id: 'studio',
            client_name: 'Studio',
            client_type: 'confidential',
            scopes: ['openid'],
          },
          { type: 'user', id: USER_ID },
        ),
      ),
      createEvent(
        refreshReuseDetectedEvent(USER_ID, {
          client_id: 'game',
          family_id: '0199a0e0-0000-7000-8000-000000000002',
        }),
      ),
      createEvent(
        clientCreatedEvent(
          'portal-app',
          { type: 'user', id: USER_ID },
          {
            client_id: 'portal-app',
            client_type: 'confidential',
            owner_user_id: USER_ID,
          },
        ),
      ),
    ];
    for (const event of events) {
      expect(catalog.validate(event).valid, event.type).toBe(true);
    }
  });
});
