import { describe, expect, it } from 'vitest';

import { eventType, parseEventType } from './event-type.ts';

describe('parseEventType', () => {
  it('splits a type into source, name and version', () => {
    expect(parseEventType('qtiauth.identity.user.banned.v1')).toEqual({
      source: 'identity',
      name: 'user.banned',
      version: 1,
    });
    expect(parseEventType('qtiauth.audit.recorded.v12')).toEqual({
      source: 'audit',
      name: 'recorded',
      version: 12,
    });
  });

  it('rejects types that break the convention', () => {
    for (const type of [
      'identity.user.banned.v1',
      'qtiauth.identity.user.banned',
      'qtiauth.identity.user.banned.v0',
      'qtiauth.identity.User.banned.v1',
      'qtiauth.identity.v1',
      'qtiauth.rpc.identity.get_user_summary',
    ]) {
      expect(() => parseEventType(type), type).toThrow('must look like');
    }
    expect(() => parseEventType('qtiauth.billing.invoice.paid.v1')).toThrow(
      'unknown source billing',
    );
  });
});

describe('eventType', () => {
  it('builds a checked type', () => {
    expect(eventType('safety', 'report.created', 2)).toBe('qtiauth.safety.report.created.v2');
    expect(() => eventType('safety', 'Report', 1)).toThrow();
  });
});
