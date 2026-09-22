import { webhookEventMatches } from '@qtiauth/config';
import { IDENTITY_EVENTS, SAFETY_EVENTS } from '@qtiauth/events';
import { describe, expect, it } from 'vitest';

import {
  endpointMatches,
  webhookEventName,
  webhookEventType,
  WEBHOOK_EVENT_TYPES,
} from './event-names.ts';

describe('webhook event names', () => {
  it('maps short names to bus types and ignores CSEA', () => {
    expect(webhookEventType('identity.user.banned')).toBe(IDENTITY_EVENTS.userBanned);
    expect(webhookEventName(IDENTITY_EVENTS.userCreated)).toBe('identity.user.created');
    expect(webhookEventName(SAFETY_EVENTS.cseaCaseOpened)).toBeUndefined();
    expect(webhookEventName(SAFETY_EVENTS.cseaEnforced)).toBeUndefined();
    expect(WEBHOOK_EVENT_TYPES.some((type) => type.includes('csea'))).toBe(false);
    expect(WEBHOOK_EVENT_TYPES).toContain(IDENTITY_EVENTS.userDeleted);
  });

  it('matches subscriptions including wildcards, but never CSEA', () => {
    expect(endpointMatches(['safety.report.*'], 'safety.report.created')).toBe(true);
    expect(endpointMatches(['*'], 'identity.user.banned')).toBe(true);
    expect(endpointMatches(['identity.user.banned'], 'identity.user.created')).toBe(false);
    expect(webhookEventMatches('safety.*', 'safety.csea.case_opened')).toBe(true);
    expect(webhookEventName(SAFETY_EVENTS.cseaCaseOpened)).toBeUndefined();
  });
});
