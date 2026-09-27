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

export const ATTACHMENT_OBJECT_PREFIX = 'attachments/';

export function attachmentObjectKey(ticketId: string, attachmentId: string): string {
  return `${ATTACHMENT_OBJECT_PREFIX}${ticketId}/${attachmentId}`;
}

export function attachmentObjectPrefix(ticketId: string): string {
  return `${ATTACHMENT_OBJECT_PREFIX}${ticketId}/`;
}

export const CLOUD_SAVE_OBJECT_PREFIX = 'cloud-saves/';

export function cloudSaveObjectKey(
  userId: string,
  gameId: string,
  slot: string,
  versionId: string,
): string {
  return `${CLOUD_SAVE_OBJECT_PREFIX}${userId}/${gameId}/${slot}/${versionId}`;
}

export function cloudSaveUserPrefix(userId: string): string {
  return `${CLOUD_SAVE_OBJECT_PREFIX}${userId}/`;
}

export function cloudSaveSlotPrefix(userId: string, gameId: string, slot: string): string {
  return `${CLOUD_SAVE_OBJECT_PREFIX}${userId}/${gameId}/${slot}/`;
}
