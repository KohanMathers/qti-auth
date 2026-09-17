import { describe, expect, it } from 'vitest';

import { generateRecoveryCodes, normalizeRecoveryCode, RECOVERY_CODE_COUNT } from './recovery.ts';

describe('recovery codes', () => {
  it('generates ten unique codes in XXXXX-XXXXX form', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    }
  });

  it('normalises dashes, spaces and case', () => {
    expect(normalizeRecoveryCode('ab12c-def3g')).toBe('AB12C-DEF3G');
    expect(normalizeRecoveryCode(' ab12cdef3g ')).toBe('AB12C-DEF3G');
    expect(normalizeRecoveryCode('ILOU-ILOU1')).toBeUndefined();
    expect(normalizeRecoveryCode('short')).toBeUndefined();
  });
});
