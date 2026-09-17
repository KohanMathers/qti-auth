import { describe, expect, it } from 'vitest';

import { parseEventType } from './event-type.ts';
import { IDENTITY_EVENTS } from './identity.ts';

describe('IDENTITY_EVENTS', () => {
  it('only names valid identity event types', () => {
    for (const type of Object.values(IDENTITY_EVENTS)) {
      expect(parseEventType(type).source).toBe('identity');
    }
  });

  it('names each event type once', () => {
    const types = Object.values(IDENTITY_EVENTS);
    expect(new Set(types).size).toBe(types.length);
  });
});
