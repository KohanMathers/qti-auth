import type { QtiauthConfig } from '@qtiauth/config';

import { exportObjectPrefix, HELD_OBJECT_PREFIX, userObjectPrefix } from './keys.ts';
import { createS3Store } from './s3.ts';
import { type ObjectStore, StorageError } from './store.ts';

export type StorageConfig = QtiauthConfig['storage'];

export function openObjectStore(config: StorageConfig): ObjectStore {
  return createS3Store(config);
}

export function tryOpenObjectStore(config: StorageConfig): ObjectStore | null {
  return config.enabled ? createS3Store(config) : null;
}

export async function eraseUserObjects(
  store: ObjectStore,
  userId: string,
  options: { preserveHeld?: boolean } = {},
): Promise<number> {
  const prefixes = [userObjectPrefix(userId), exportObjectPrefix(userId)];
  if (options.preserveHeld !== true) prefixes.push(`${HELD_OBJECT_PREFIX}${userId}/`);
  let deleted = 0;
  for (const prefix of prefixes) deleted += await store.deletePrefix(prefix);
  return deleted;
}

export { StorageError };
