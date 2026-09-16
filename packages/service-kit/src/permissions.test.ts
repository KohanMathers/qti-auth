import { describe, expect, it } from 'vitest';

import { definePermissions, grantMatches, missingPermissions } from './permissions.ts';

const permissions = definePermissions({
  'users.read': { description: 'Read users' },
  'users.ban': { description: 'Ban users' },
  'safety.reports.read': { description: 'Read reports' },
  'safety.csea.access': { description: 'CSEA cases', wildcard: false },
});

describe('definePermissions', () => {
  it('rejects bad names and missing descriptions', () => {
    expect(() => definePermissions({ users: { description: 'x' } })).toThrow('dotted lowercase');
    expect(() => definePermissions({ 'Users.Read': { description: 'x' } })).toThrow(
      'dotted lowercase',
    );
    expect(() => definePermissions({ 'users.read': { description: '' } })).toThrow(
      'needs a description',
    );
  });

  it('defaults wildcard matching to on', () => {
    expect(permissions['users.read'].wildcard).toBe(true);
    expect(permissions['safety.csea.access'].wildcard).toBe(false);
  });
});

describe('grantMatches', () => {
  it('matches exact grants and prefix wildcards', () => {
    expect(grantMatches('users.read', permissions['users.read'])).toBe(true);
    expect(grantMatches('users.*', permissions['users.read'])).toBe(true);
    expect(grantMatches('*', permissions['users.ban'])).toBe(true);
    expect(grantMatches('safety.*', permissions['safety.reports.read'])).toBe(true);
    expect(grantMatches('user.*', permissions['users.read'])).toBe(false);
    expect(grantMatches('users.read.*', permissions['users.read'])).toBe(false);
    expect(grantMatches('users*', permissions['users.read'])).toBe(false);
  });

  it('never matches a no-wildcard permission with a wildcard', () => {
    const csea = permissions['safety.csea.access'];
    expect(grantMatches('*', csea)).toBe(false);
    expect(grantMatches('safety.*', csea)).toBe(false);
    expect(grantMatches('safety.csea.*', csea)).toBe(false);
    expect(grantMatches('safety.csea.access', csea)).toBe(true);
  });
});

describe('missingPermissions', () => {
  it('lists required permissions no grant covers', () => {
    expect(
      missingPermissions(
        ['users.*', 'safety.*'],
        [permissions['users.ban'], permissions['safety.csea.access']],
      ),
    ).toEqual(['safety.csea.access']);
  });
});
