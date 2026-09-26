import { describe, expect, it } from 'vitest';

import { parseEventType } from './event-type.ts';
import { GAMES_EVENTS } from './games.ts';

describe('GAMES_EVENTS', () => {
  it('only names valid games event types', () => {
    for (const type of Object.values(GAMES_EVENTS)) {
      expect(parseEventType(type).source).toBe('games');
    }
  });

  it('names each event type once', () => {
    const types = Object.values(GAMES_EVENTS);
    expect(new Set(types).size).toBe(types.length);
  });
});
