import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { QtiauthConfig } from '@qtiauth/config';
import type { ObjectStore, StoredObject } from '@qtiauth/storage';

export const BACKUP_OBJECT_PREFIX = 'backups/';

export interface BackupHandle {
  id: string;
  createdAt: Date;
  size: number;
  location: string;
}

export type BackupDestination = DirectoryDestination | StorageDestination;

export interface DirectoryDestination {
  kind: 'directory';
  directory: string;
}

export interface StorageDestination {
  kind: 'storage';
  store: ObjectStore;
  bucket: string;
}

export class BackupDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupDestinationError';
  }
}

export function backupDestination(
  backups: QtiauthConfig['backups'],
  storage: QtiauthConfig['storage'],
  store: ObjectStore | null,
): BackupDestination {
  if (backups.destination === 'storage') {
    if (store === null) {
      throw new BackupDestinationError(
        'backups.destination is storage but storage.enabled is false',
      );
    }
    return { kind: 'storage', store, bucket: storage.bucket };
  }
  return { kind: 'directory', directory: backups.directory };
}

export function backupObjectKey(id: string): string {
  return `${BACKUP_OBJECT_PREFIX}${id}.bak`;
}

export function backupFileName(id: string): string {
  return `${id}.bak`;
}

export async function writeBackup(
  destination: BackupDestination,
  handle: { id: string; body: Buffer },
): Promise<BackupHandle> {
  const createdAt = new Date();
  if (destination.kind === 'storage') {
    const key = backupObjectKey(handle.id);
    await destination.store.put(key, handle.body, 'application/octet-stream');
    return { id: handle.id, createdAt, size: handle.body.length, location: key };
  }
  await mkdir(destination.directory, { recursive: true });
  const path = join(destination.directory, backupFileName(handle.id));
  await writeFile(path, handle.body, { mode: 0o600 });
  return { id: handle.id, createdAt, size: handle.body.length, location: path };
}

export async function readBackup(destination: BackupDestination, id: string): Promise<Buffer> {
  if (destination.kind === 'storage') {
    const body = await destination.store.get(backupObjectKey(id));
    if (body === undefined) {
      throw new BackupDestinationError(`Backup ${id} was not found in object storage`);
    }
    return Buffer.from(body);
  }
  const { readFile } = await import('node:fs/promises');
  return readFile(join(destination.directory, backupFileName(id)));
}

export async function listBackups(destination: BackupDestination): Promise<BackupHandle[]> {
  if (destination.kind === 'storage') {
    const objects = await destination.store.list(BACKUP_OBJECT_PREFIX);
    return objects.filter(isBackupObject).map(objectToHandle);
  }
  let names: string[];
  try {
    names = await readdir(destination.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const handles: BackupHandle[] = [];
  for (const name of names) {
    if (!name.endsWith('.bak')) continue;
    const path = join(destination.directory, name);
    const info = await stat(path);
    handles.push({
      id: name.slice(0, -'.bak'.length),
      createdAt: info.mtime,
      size: info.size,
      location: path,
    });
  }
  return handles;
}

export async function deleteBackup(destination: BackupDestination, id: string): Promise<void> {
  if (destination.kind === 'storage') {
    await destination.store.delete(backupObjectKey(id));
    return;
  }
  const path = join(destination.directory, backupFileName(id));
  try {
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function isBackupObject(object: StoredObject): boolean {
  return object.key.startsWith(BACKUP_OBJECT_PREFIX) && object.key.endsWith('.bak');
}

function objectToHandle(object: StoredObject): BackupHandle {
  const name = object.key.slice(BACKUP_OBJECT_PREFIX.length, -'.bak'.length);
  return { id: name, createdAt: object.lastModified, size: object.size, location: object.key };
}
