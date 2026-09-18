import { describe, expect, it } from 'vitest';

import { AUDIT_EVENTS } from './audit.ts';
import { parseEventType } from './event-type.ts';

describe('AUDIT_EVENTS', () => {
  it('only names valid audit event types', () => {
    for (const type of Object.values(AUDIT_EVENTS)) {
      expect(parseEventType(type).source).toBe('audit');
    }
  });
});
