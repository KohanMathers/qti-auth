import { ACCOUNT_STATES } from '@qtiauth/service-kit';
import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_TRANSITIONS,
  AccountStateError,
  assertTransition,
  canTransition,
  initialAccountState,
  OPEN_ACCOUNT_STATES,
  SIGNED_IN_STATES,
} from './accounts.ts';

describe('account state machine', () => {
  it('covers every account state', () => {
    expect(Object.keys(ACCOUNT_TRANSITIONS).sort()).toEqual([...ACCOUNT_STATES].sort());
    for (const targets of Object.values(ACCOUNT_TRANSITIONS)) {
      for (const target of targets) expect(ACCOUNT_STATES).toContain(target);
    }
  });

  it('never leaves deleted, and only reaches it through pending states', () => {
    expect(ACCOUNT_TRANSITIONS.deleted).toEqual([]);
    const intoDeleted = ACCOUNT_STATES.filter((state) => canTransition(state, 'deleted'));
    expect(intoDeleted.sort()).toEqual([
      'pending_deletion',
      'pending_email_verification',
      'pending_parental_consent',
    ]);
  });

  it('refuses transitions that are not listed', () => {
    expect(() => {
      assertTransition('banned', 'locked');
    }).toThrow(AccountStateError);
    expect(() => {
      assertTransition('locked', 'active');
    }).not.toThrow();
  });

  it('starts verified adults as active and younger users as pending parental consent', () => {
    expect(initialAccountState({ emailVerified: true, age: 13, consentAge: 13 })).toBe('active');
    expect(initialAccountState({ emailVerified: true, age: 12, consentAge: 13 })).toBe(
      'pending_parental_consent',
    );
    expect(initialAccountState({ emailVerified: false, age: 30, consentAge: 13 })).toBe(
      'pending_email_verification',
    );
  });

  it('lets every state but deleted be signed in to', () => {
    expect(SIGNED_IN_STATES).not.toContain('deleted');
    expect(SIGNED_IN_STATES).toHaveLength(ACCOUNT_STATES.length - 1);
  });

  it('keeps banned and locked accounts off ordinary account-management routes', () => {
    expect(OPEN_ACCOUNT_STATES).not.toContain('banned');
    expect(OPEN_ACCOUNT_STATES).not.toContain('locked');
    expect(OPEN_ACCOUNT_STATES).not.toContain('deleted');
    expect(OPEN_ACCOUNT_STATES).toContain('active');
  });
});
