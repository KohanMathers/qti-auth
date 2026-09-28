import { parseEncryptionKey } from '@qtiauth/keys';

import type { Context } from './service.ts';

export class BackupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupConfigError';
  }
}

const cache = new WeakMap<object, Buffer>();

export function backupEncryptionKey(config: Context['config']): Buffer {
  const cached = cache.get(config);
  if (cached) return cached;
  if (config.backups.encryption_key === '') {
    throw new BackupConfigError(
      'backups.encryption_key is empty; set BACKUP_ENCRYPTION_KEY in .env before starting the backup service',
    );
  }
  const key = parseEncryptionKey(config.backups.encryption_key, 'backups.encryption_key');
  cache.set(config, key);
  return key;
}

export function backupArchiveId(now: Date): string {
  const iso = now.toISOString();
  return iso.replace(/[:.]/g, '-').replace('Z', 'Z');
}
