import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { canonicalUsername, usernameReserved, usernameRuleReason } from './usernames.ts';

const settings = sections.usernames.parse({});

describe('username rules', () => {
  it('accepts 8–18 letters, digits and underscores, case-insensitively', () => {
    expect(usernameRuleReason('aliceusr', settings)).toBeUndefined();
    expect(usernameRuleReason('AliceUsr', settings)).toBeUndefined();
    expect(usernameRuleReason('user_123', settings)).toBeUndefined();
    expect(canonicalUsername('AliceUsr')).toBe('aliceusr');
  });

  it('rejects length and characters outside the charset', () => {
    expect(usernameRuleReason('short', settings)).toBe('too_short');
    expect(usernameRuleReason('a'.repeat(19), settings)).toBe('too_long');
    expect(usernameRuleReason('bad-name!', settings)).toBe('bad_charset');
    expect(usernameRuleReason('has space', settings)).toBe('bad_charset');
  });

  it('treats reserved names and prefixes as unavailable regardless of case', () => {
    const reserved = {
      reserved: ['Administrator'],
      reserved_prefixes: ['Staff_'],
    };
    expect(usernameReserved('administrator', reserved)).toBe(true);
    expect(usernameReserved('ADMINISTRATOR', reserved)).toBe(true);
    expect(usernameReserved('aliceusr', reserved)).toBe(false);
    expect(usernameReserved('staff_ok1', reserved)).toBe(true);
    expect(usernameReserved('Staff_User', reserved)).toBe(true);
    expect(usernameReserved('notstaff', reserved)).toBe(false);
  });
});
