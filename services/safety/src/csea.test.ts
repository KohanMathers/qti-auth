import { parseEncryptionKey, seal } from '@qtiauth/keys';
import { describe, expect, it } from 'vitest';

import {
  deadlineFor,
  DESTROYED_SEALED,
  HOLD_REASON,
  openEvidence,
  PROTECTIVE_RULE_ID,
  tryEncryptionKey,
} from './csea.ts';

const KEY = Buffer.alloc(32, 3).toString('base64');

describe('CSEA helpers', () => {
  it('maps NCA priorities to the configured submission windows', () => {
    const config = {
      encryption_key: '',
      nca_portal_url: '',
      protective_lock: 7 * 86_400_000,
      priority_1: 15 * 60_000,
      priority_2: 4 * 3_600_000,
      priority_3: 86_400_000,
    };
    const now = new Date('2026-04-07T12:00:00.000Z');
    expect(deadlineFor(config, 1, now).getTime() - now.getTime()).toBe(15 * 60_000);
    expect(deadlineFor(config, 2, now).getTime() - now.getTime()).toBe(4 * 3_600_000);
    expect(deadlineFor(config, 3, now).getTime() - now.getTime()).toBe(86_400_000);
  });

  it('encrypts evidence so plaintext never appears in the sealed blob', () => {
    const key = parseEncryptionKey(KEY, 'safety.csea.encryption_key');
    const plaintext = 'held-snapshot-plaintext';
    const sealed = JSON.stringify(seal(Buffer.from(plaintext, 'utf8'), key, 'case-1'));
    expect(sealed).not.toContain(plaintext);
    expect(openEvidence(sealed, key, 'case-1')).toBe(plaintext);
    expect(openEvidence(DESTROYED_SEALED, key, 'case-1')).toBe('');
    expect(tryEncryptionKey('')).toBeUndefined();
    expect(tryEncryptionKey(KEY)?.equals(key)).toBe(true);
  });

  it('keeps hold reasons and protective rule ids free of case language', () => {
    expect(HOLD_REASON).toBe('Open investigation');
    expect(HOLD_REASON.toLowerCase()).not.toContain('csea');
    expect(PROTECTIVE_RULE_ID).toBe('protective');
    expect(PROTECTIVE_RULE_ID.toLowerCase()).not.toContain('csea');
  });
});
