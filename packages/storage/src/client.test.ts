import { describe, expect, it } from 'vitest';

import { eraseUserObjects } from './client.ts';
import { createMemoryStore } from './memory.ts';
import { exportObjectKey, heldObjectKey, userObjectKey } from './keys.ts';

describe('createMemoryStore', () => {
  it('stores, lists, deletes and erases a user except held objects', async () => {
    const userId = '0199a0e0-0000-7000-8000-000000000001';
    const store = createMemoryStore(() => new Date('2026-09-18T12:00:00Z'));
    await store.put(
      userObjectKey(userId, 'note.txt'),
      new TextEncoder().encode('hi'),
      'text/plain',
    );
    await store.put(
      exportObjectKey(userId, 'exp'),
      new TextEncoder().encode('zip'),
      'application/zip',
    );
    await store.put(
      heldObjectKey(userId, 'case.json'),
      new TextEncoder().encode('{}'),
      'application/json',
    );

    expect(
      new TextDecoder().decode((await store.get(userObjectKey(userId, 'note.txt'))) ?? EMPTY),
    ).toBe('hi');
    expect(await store.presignGet(userObjectKey(userId, 'note.txt'), 60)).toContain('memory://');
    expect(await eraseUserObjects(store, userId, { preserveHeld: true })).toBe(2);
    expect(await store.get(userObjectKey(userId, 'note.txt'))).toBeUndefined();
    expect(await store.get(heldObjectKey(userId, 'case.json'))).toBeDefined();
    expect(await eraseUserObjects(store, userId)).toBe(1);
    expect(await store.list('')).toEqual([]);
  });
});

const EMPTY = new Uint8Array();
