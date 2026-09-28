import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryStore } from '@qtiauth/storage';
import { afterEach, describe, expect, it } from 'vitest';

import {
  backupDestination,
  BackupDestinationError,
  backupFileName,
  backupObjectKey,
  listBackups,
  readBackup,
  writeBackup,
} from './destination.ts';

const backupsBase = {
  retention: 35 * 24 * 60 * 60 * 1000,
  encryption_key: '',
  admin_user: 'postgres',
  admin_password: '',
  pg_dump: 'pg_dump',
  pg_restore: 'pg_restore',
  psql: 'psql',
  scratch_database: 'qtiauth_scratch',
  dump_timeout: 60 * 60 * 1000,
  chunk_size: 1_048_576,
};

const storage = {
  enabled: true,
  endpoint: 'http://minio:9000',
  region: 'us-east-1',
  bucket: 'qtiauth',
  access_key: 'a',
  secret_key: 'b',
  force_path_style: true,
  create_bucket: true,
  tls: { ca_file: null },
  presign_expires: 900_000,
} as const;

let dir: string | undefined;

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('backup destination', () => {
  it('picks the directory destination by default', () => {
    const destination = backupDestination(
      { ...backupsBase, destination: 'directory', directory: '/tmp/backups' },
      { ...storage, enabled: false },
      null,
    );
    expect(destination).toEqual({ kind: 'directory', directory: '/tmp/backups' });
  });

  it('picks the storage destination when configured', () => {
    const store = createMemoryStore();
    const destination = backupDestination(
      { ...backupsBase, destination: 'storage', directory: '/tmp' },
      storage,
      store,
    );
    expect(destination).toEqual({ kind: 'storage', store, bucket: 'qtiauth' });
  });

  it('rejects a storage destination without a store', () => {
    expect(() =>
      backupDestination(
        { ...backupsBase, destination: 'storage', directory: '/tmp' },
        storage,
        null,
      ),
    ).toThrow(BackupDestinationError);
  });

  it('writes and reads a backup on disk', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qtiauth-backup-'));
    const body = Buffer.from('encrypted bytes');
    const handle = await writeBackup(
      { kind: 'directory', directory: dir },
      {
        id: '2026-09-28T00-00-00-000Z',
        body,
      },
    );
    expect(handle.size).toBe(body.length);
    expect(await readFile(join(dir, backupFileName(handle.id)))).toEqual(body);
    expect(await readBackup({ kind: 'directory', directory: dir }, handle.id)).toEqual(body);
    const listed = await listBackups({ kind: 'directory', directory: dir });
    expect(listed.map((entry) => entry.id)).toEqual([handle.id]);
  });

  it('names backup objects predictably', () => {
    expect(backupObjectKey('id')).toBe('backups/id.bak');
    expect(backupFileName('id')).toBe('id.bak');
  });
});
