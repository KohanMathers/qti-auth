export const USER_OBJECT_PREFIX = 'users/';
export const HELD_OBJECT_PREFIX = 'legal-hold/';
export const EXPORT_OBJECT_PREFIX = 'exports/';
export const LEDGER_OBJECT_PREFIX = 'deletion-ledger/';

export function userObjectKey(userId: string, name: string): string {
  return `${USER_OBJECT_PREFIX}${userId}/${name}`;
}

export function userObjectPrefix(userId: string): string {
  return `${USER_OBJECT_PREFIX}${userId}/`;
}

export function heldObjectKey(userId: string, name: string): string {
  return `${HELD_OBJECT_PREFIX}${userId}/${name}`;
}

export function heldObjectPrefix(userId: string): string {
  return `${HELD_OBJECT_PREFIX}${userId}/`;
}

export function exportObjectKey(userId: string, exportId: string): string {
  return `${EXPORT_OBJECT_PREFIX}${userId}/${exportId}.zip`;
}

export function exportObjectPrefix(userId: string): string {
  return `${EXPORT_OBJECT_PREFIX}${userId}/`;
}

export function ledgerObjectKey(userId: string): string {
  return `${LEDGER_OBJECT_PREFIX}${userId}.json`;
}

export function isHeldObjectKey(key: string): boolean {
  return key.startsWith(HELD_OBJECT_PREFIX);
}
