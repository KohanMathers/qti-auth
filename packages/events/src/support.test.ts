import { describe, expect, it } from 'vitest';

import { parseEventType } from './event-type.ts';
import { SUPPORT_EVENTS } from './support.ts';

describe('SUPPORT_EVENTS', () => {
  it('only names valid support event types', () => {
    for (const type of Object.values(SUPPORT_EVENTS)) {
      expect(parseEventType(type).source).toBe('support');
    }
  });

  it('names each event type once', () => {
    const types = Object.values(SUPPORT_EVENTS);
    expect(new Set(types).size).toBe(types.length);
  });
});
