import { describe, expect, it } from 'vitest';

import {
  cloudSaveObjectKey,
  cloudSaveSlotPrefix,
  cloudSaveUserPrefix,
  exportObjectKey,
  heldObjectKey,
  isHeldObjectKey,
  ledgerObjectKey,
  userObjectKey,
  userObjectPrefix,
} from './keys.ts';

describe('object keys', () => {
  const userId = '0199a0e0-0000-7000-8000-000000000001';
  const gameId = '0199a0e0-0000-7000-8000-000000000002';
  const versionId = '0199a0e0-0000-7000-8000-000000000003';

  it('nests user objects, exports and the deletion ledger under stable prefixes', () => {
    expect(userObjectKey(userId, 'saves/slot-1')).toBe(`users/${userId}/saves/slot-1`);
    expect(userObjectPrefix(userId)).toBe(`users/${userId}/`);
    expect(exportObjectKey(userId, 'exp-1')).toBe(`exports/${userId}/exp-1.zip`);
    expect(heldObjectKey(userId, 'report.json')).toBe(`legal-hold/${userId}/report.json`);
    expect(ledgerObjectKey(userId)).toBe(`deletion-ledger/${userId}.json`);
  });

  it('treats only the legal-hold prefix as held', () => {
    expect(isHeldObjectKey(heldObjectKey(userId, 'a'))).toBe(true);
    expect(isHeldObjectKey(userObjectKey(userId, 'a'))).toBe(false);
  });

  it('nests cloud saves under a per-user prefix and a per-slot subprefix', () => {
    expect(cloudSaveObjectKey(userId, gameId, 'slot-1', versionId)).toBe(
      `cloud-saves/${userId}/${gameId}/slot-1/${versionId}`,
    );
    expect(cloudSaveUserPrefix(userId)).toBe(`cloud-saves/${userId}/`);
    expect(cloudSaveSlotPrefix(userId, gameId, 'slot-1')).toBe(
      `cloud-saves/${userId}/${gameId}/slot-1/`,
    );
  });
});
