import { describe, expect, it } from 'vitest';

import { graduationGraceEndsAt, guardianRemovalMode } from './graduation.ts';

describe('guardianRemovalMode', () => {
  const now = new Date('2026-09-18T12:00:00.000Z');
  const options = { consentAge: 13, adultAge: 18, graceMs: 30 * 86_400_000, now };

  it('blocks below consent_age and during the grace period', () => {
    expect(guardianRemovalMode('2016-09-18', options)).toBe('blocked');
    expect(guardianRemovalMode('2013-09-13', options)).toBe('blocked');
  });

  it('needs guardian approval after the grace period and before the adult band', () => {
    expect(guardianRemovalMode('2012-09-18', options)).toBe('request');
    expect(
      guardianRemovalMode('2013-09-18', { ...options, now: new Date('2026-10-18T00:00:00.000Z') }),
    ).toBe('request');
  });

  it('lets an adult remove the link without approval', () => {
    expect(guardianRemovalMode('2008-09-18', options)).toBe('self');
  });
});

describe('graduationGraceEndsAt', () => {
  it('adds the grace period to the day they reached consent_age', () => {
    expect(graduationGraceEndsAt('2013-09-18', 13, 30 * 86_400_000).toISOString()).toBe(
      '2026-10-18T00:00:00.000Z',
    );
  });
});
