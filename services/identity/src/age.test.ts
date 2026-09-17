import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { ageBand, ageOn, isValidDateOfBirth } from './age.ts';

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
