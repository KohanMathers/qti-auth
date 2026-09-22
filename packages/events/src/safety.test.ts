import { describe, expect, it } from 'vitest';

import { parseEventType } from './event-type.ts';
import { SAFETY_EVENTS } from './safety.ts';

describe('SAFETY_EVENTS', () => {
  it('only names valid safety event types', () => {
    for (const type of Object.values(SAFETY_EVENTS)) {
      expect(parseEventType(type).source).toBe('safety');
    }
  });

  it('names each event type once', () => {
    const types = Object.values(SAFETY_EVENTS);
    expect(new Set(types).size).toBe(types.length);
  });
});
