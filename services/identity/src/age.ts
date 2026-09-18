import type { QtiauthConfig } from '@qtiauth/config';
import type { AgeBand } from '@qtiauth/service-kit';

export type AgeBands = QtiauthConfig['age']['bands'];

export const MAX_AGE = 150;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): [number, number, number] | undefined {
  const match = DATE.exec(date);
  if (!match) return undefined;
  const [, year = '', month = '', day = ''] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (parsed.toISOString().slice(0, 10) !== date) return undefined;
  return [Number(year), Number(month), Number(day)];
}

export function ageOn(dateOfBirth: string, today: Date): number {
  const born = parts(dateOfBirth);
  if (!born) throw new RangeError(`Not a date: ${dateOfBirth}`);
  const [year, month, day] = born;
  const thisMonth = today.getUTCMonth() + 1;
  const hadBirthday = thisMonth > month || (thisMonth === month && today.getUTCDate() >= day);
  return today.getUTCFullYear() - year - (hadBirthday ? 0 : 1);
}

export function isValidDateOfBirth(value: string, today: Date): boolean {
  if (!parts(value)) return false;
  const age = ageOn(value, today);
  return value <= today.toISOString().slice(0, 10) && age <= MAX_AGE;
}

export function ageBand(age: number, bands: AgeBands): AgeBand {
  if (age >= bands.adult) return 'adult';
  if (age >= bands['16_to_17']) return '16_to_17';
  if (age >= bands['13_to_15']) return '13_to_15';
  return 'under_13';
}

export function bandOn(dateOfBirth: string, today: Date, bands: AgeBands): AgeBand {
  return ageBand(ageOn(dateOfBirth, today), bands);
}

export function under18(age: number, bands: AgeBands): boolean {
  return age < bands.adult;
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function previousUtcDay(date: Date): Date {
  const day = utcDay(date);
  const [year = 0, month = 1, dayOfMonth = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, dayOfMonth - 1));
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export interface AgePrivacyDefaults {
  publicProfile: boolean;
  leaderboardVisible: boolean;
  securityNotifications: boolean;
}

export function agePrivacyDefaults(isUnder18: boolean): AgePrivacyDefaults {
  return {
    publicProfile: !isUnder18,
    leaderboardVisible: !isUnder18,
    securityNotifications: true,
  };
}

function nthBirthdayDate(today: Date, age: number): string {
  const year = today.getUTCFullYear() - age;
  const month = today.getUTCMonth();
  const day = today.getUTCDate();
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

export function dateOfBirthBounds(
  band: AgeBand,
  today: Date,
  bands: AgeBands,
): { after: string; through: string } {
  const lower =
    band === 'adult'
      ? bands.adult
      : band === '16_to_17'
        ? bands['16_to_17']
        : band === '13_to_15'
          ? bands['13_to_15']
          : 0;
  const upper =
    band === 'under_13'
      ? bands['13_to_15']
      : band === '13_to_15'
        ? bands['16_to_17']
        : band === '16_to_17'
          ? bands.adult
          : MAX_AGE + 1;
  return { after: nthBirthdayDate(today, upper), through: nthBirthdayDate(today, lower) };
}
