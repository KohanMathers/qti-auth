import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import {
  ageBand,
  ageOn,
  agePrivacyDefaults,
  bandOn,
  dateOfBirthBounds,
  dateWhenAgeReached,
  isLeapYear,
  isValidDateOfBirth,
  previousUtcDay,
  under18,
  utcDay,
} from './age.ts';

const bands = sections.age.parse({}).bands;

describe('ageOn', () => {
  it('counts whole years, turning over on the birthday', () => {
    expect(ageOn('2010-09-17', new Date('2026-09-16T23:59:59Z'))).toBe(15);
    expect(ageOn('2010-09-17', new Date('2026-09-17T00:00:00Z'))).toBe(16);
  });

  it('turns a 29 February birthday over on 1 March in other years', () => {
    expect(ageOn('2008-02-29', new Date('2026-02-28T12:00:00Z'))).toBe(17);
    expect(ageOn('2008-02-29', new Date('2026-03-01T12:00:00Z'))).toBe(18);
  });
});

describe('dateWhenAgeReached', () => {
  it('is the UTC calendar day they turn that age', () => {
    expect(dateWhenAgeReached('2013-09-18', 13).toISOString()).toBe('2026-09-18T00:00:00.000Z');
  });

  it('rolls a 29 February birthday to 1 March in other years', () => {
    expect(dateWhenAgeReached('2008-02-29', 18).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('isValidDateOfBirth', () => {
  const today = new Date('2026-09-17T12:00:00Z');

  it('accepts real past dates', () => {
    expect(isValidDateOfBirth('1990-01-31', today)).toBe(true);
    expect(isValidDateOfBirth('2026-09-17', today)).toBe(true);
  });

  it('rejects impossible, future and implausibly old dates', () => {
    for (const value of ['1990-02-30', '1990-13-01', '90-01-01', '2026-09-18', '1875-01-01', '']) {
      expect(isValidDateOfBirth(value, today), value).toBe(false);
    }
  });
});

describe('ageBand', () => {
  it('uses the configured band boundaries', () => {
    expect([12, 13, 15, 16, 17, 18, 40].map((age) => ageBand(age, bands))).toEqual([
      'under_13',
      '13_to_15',
      '13_to_15',
      '16_to_17',
      '16_to_17',
      'adult',
      'adult',
    ]);
    expect(ageBand(16, { '13_to_15': 14, '16_to_17': 17, adult: 19 })).toBe('13_to_15');
  });
});

describe('under-18 defaults', () => {
  it('turns public profile and leaderboards off under 18, and leaves security notifications on', () => {
    expect(agePrivacyDefaults(true)).toEqual({
      publicProfile: false,
      leaderboardVisible: false,
      securityNotifications: true,
    });
    expect(agePrivacyDefaults(false)).toEqual({
      publicProfile: true,
      leaderboardVisible: true,
      securityNotifications: true,
    });
    expect(under18(17, bands)).toBe(true);
    expect(under18(18, bands)).toBe(false);
  });
});

describe('birthday band changes', () => {
  it('moves 16_to_17 to adult overnight on the 18th birthday', () => {
    const today = new Date('2026-09-17T00:05:00Z');
    const yesterday = previousUtcDay(today);
    expect(bandOn('2008-09-17', yesterday, bands)).toBe('16_to_17');
    expect(bandOn('2008-09-17', today, bands)).toBe('adult');
    expect(bandOn('2009-09-17', yesterday, bands)).toBe('16_to_17');
    expect(bandOn('2009-09-17', today, bands)).toBe('16_to_17');
  });

  it('turns a 29 February 18th birthday over on 1 March in other years', () => {
    const today = new Date('2026-03-01T00:05:00Z');
    expect(bandOn('2008-02-29', previousUtcDay(today), bands)).toBe('16_to_17');
    expect(bandOn('2008-02-29', today, bands)).toBe('adult');
  });
});

describe('calendar helpers', () => {
  it('steps back one UTC day, including across months', () => {
    expect(utcDay(new Date('2026-09-17T00:05:00Z'))).toBe('2026-09-17');
    expect(previousUtcDay(new Date('2026-09-17T12:00:00Z')).toISOString()).toBe(
      '2026-09-16T00:00:00.000Z',
    );
    expect(previousUtcDay(new Date('2026-03-01T00:00:00Z')).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('treats 2000 and 2024 as leap years, and 1900 and 2026 as not', () => {
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2026)).toBe(false);
  });
});

describe('dateOfBirthBounds', () => {
  const today = new Date('2026-09-18T12:00:00Z');

  it('matches ageBand for the dates on each side of a boundary', () => {
    const adult = dateOfBirthBounds('adult', today, bands);
    expect(ageBand(ageOn(adult.through, today), bands)).toBe('adult');
    expect(ageBand(ageOn('2008-09-19', today), bands)).toBe('16_to_17');

    const teens = dateOfBirthBounds('16_to_17', today, bands);
    expect(teens.after).toBe(adult.through);
    expect(ageBand(ageOn('2008-09-19', today), bands)).toBe('16_to_17');
    expect(ageBand(ageOn(teens.through, today), bands)).toBe('16_to_17');
    expect(ageBand(ageOn('2010-09-19', today), bands)).toBe('13_to_15');

    const younger = dateOfBirthBounds('13_to_15', today, bands);
    expect(younger.after).toBe(teens.through);
    expect(ageBand(ageOn(younger.through, today), bands)).toBe('13_to_15');

    const children = dateOfBirthBounds('under_13', today, bands);
    expect(children.after).toBe(younger.through);
    expect(children.through).toBe('2026-09-18');
    expect(ageBand(ageOn('2013-09-19', today), bands)).toBe('under_13');
  });
});
