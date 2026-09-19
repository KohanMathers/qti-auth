import { describe, expect, it } from 'vitest';

import { parseEventType } from './event-type.ts';
import { OIDC_EVENTS } from './oidc.ts';

describe('OIDC_EVENTS', () => {
  it('only names valid oidc event types', () => {
    for (const type of Object.values(OIDC_EVENTS)) {
      expect(parseEventType(type).source).toBe('oidc');
    }
  });

  it('names each event type once', () => {
    const types = Object.values(OIDC_EVENTS);
    expect(new Set(types).size).toBe(types.length);
  });
});
