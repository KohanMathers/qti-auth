import { exportObjectPrefix, heldObjectPrefix, userObjectPrefix } from './keys.ts';
import { createS3Store, type StorageConfig } from './s3.ts';
import type { ObjectStore } from './store.ts';

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
  if (options.preserveHeld !== true) prefixes.push(heldObjectPrefix(userId));
  let deleted = 0;
  for (const prefix of prefixes) deleted += await store.deletePrefix(prefix);
  return deleted;
}
