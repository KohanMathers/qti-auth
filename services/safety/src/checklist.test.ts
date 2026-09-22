import { describe, expect, it } from 'vitest';

import {
  CSEA_CHECKLIST_FIELDS,
  declarationComplete,
  emptyChecklist,
  mergeChecklist,
  parseChecklist,
  prefillChecklist,
} from './checklist.ts';

describe('CSEA checklist', () => {
  const now = new Date('2026-04-07T12:00:00.000Z');

  it('prefills detection method, upload time and an incomplete declaration', () => {
    const checklist = prefillChecklist({
      source: 'automated',
      gameId: 'arena',
      capturedAt: now,
      hasSnapshot: true,
      now,
    });
    expect(checklist.detection_method).toEqual({ available: true, value: 'automated flag' });
    expect(checklist.platform).toEqual({ available: true, value: 'arena' });
    expect(checklist.uploaded_at).toEqual({ available: true, value: now.toISOString() });
    expect(checklist.detected_content).toEqual({ available: true, value: 'held' });
    expect(declarationComplete(checklist)).toBe(false);
  });

  it('parses unknown objects into the full field set and merges staff updates', () => {
    expect(Object.keys(parseChecklist(null)).sort()).toEqual([...CSEA_CHECKLIST_FIELDS].sort());
    const merged = mergeChecklist(emptyChecklist(), {
      declaration: { available: true, value: 'true' },
      reporting_person_name: { available: true, value: 'A moderator' },
    });
    expect(declarationComplete(merged)).toBe(true);
    expect(merged.reporting_person_name).toEqual({ available: true, value: 'A moderator' });
  });
});
