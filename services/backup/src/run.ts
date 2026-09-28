import { DB_SCHEMAS } from '@qtiauth/config';
import type { Logger } from '@qtiauth/observability';
import type { ObjectStore } from '@qtiauth/storage';

import type { BackupDestination, BackupHandle } from './destination.ts';
import { writeBackup } from './destination.ts';
import { pgDumpSchema, pgDumpVersion } from './dump.ts';
import type { Manifest, StorageManifest } from './manifest.ts';
import { STORAGE_MANIFEST_BLOB_PATH } from './manifest.ts';
import type { Context } from './service.ts';
import { backupArchiveId } from './settings.ts';
import type { BlobResult } from './writer.ts';
import { createArchiveDraft, encodeStorageManifest } from './writer.ts';

export interface RunBackupOptions {
  config: Context['config'];
  destination: BackupDestination;
  key: Buffer;
  store: ObjectStore | null;
  serviceVersions: Record<string, string>;
  log: Logger;
  postgresVersion: string;
  now: Date;
}

export async function runBackup(options: RunBackupOptions): Promise<BackupHandle> {
  const { config, destination, key, store, log } = options;
  const archiveId = backupArchiveId(options.now);
  const draft = createArchiveDraft({
    archiveId,
    key,
    chunkSize: config.backups.chunk_size,
  });

  const pgDumpVersionString = await pgDumpVersion(config.backups.pg_dump);
  const schemaResults: BlobResult[] = [];
  for (const schema of DB_SCHEMAS) {
    const path = `schemas/${schema}.dump`;
    const blob = draft.openBlob(path);
    const dumped = await pgDumpSchema(
      {
        binary: config.backups.pg_dump,
        host: config.database.host,
        port: config.database.port,
        database: config.database.name,
        user: config.backups.admin_user,
        password: config.backups.admin_password,
        schema,
        timeoutMs: config.backups.dump_timeout,
        ssl: config.database.ssl,
      },
      { onChunk: (chunk) => blob.push(chunk) },
    );
    const result = await blob.finish();
    schemaResults.push(result);
    log.info('schema dumped', {
      schema,
      plaintext_bytes: result.plaintextBytes,
      dump_bytes: dumped,
    });
  }

  const storageManifest = await captureStorageManifest(store, config, options.now);
  const storageBlob = draft.openBlob(STORAGE_MANIFEST_BLOB_PATH);
  if (storageManifest) {
    await storageBlob.push(encodeStorageManifest(storageManifest));
  }
  await storageBlob.finish();

  const manifest: Manifest = {
    archive_id: archiveId,
    created_at: options.now.toISOString(),
    database: config.database.name,
    schemas: schemaResults.map((entry, index) => ({
      schema: DB_SCHEMAS[index] ?? 'unknown',
      path: entry.path,
      chunks: entry.chunks,
      plaintext_bytes: entry.plaintextBytes,
      pg_dump_version: pgDumpVersionString,
    })),
    storage: {
      bucket: storageManifest?.bucket ?? null,
      object_count: storageManifest?.objects.length ?? 0,
      total_bytes: storageManifest?.objects.reduce((sum, entry) => sum + entry.size, 0) ?? 0,
    },
    postgres_version: options.postgresVersion,
    service_versions: options.serviceVersions,
  };

  const body = draft.finalize(manifest);
  const handle = await writeBackup(destination, { id: archiveId, body });
  log.info('backup written', {
    archive_id: archiveId,
    location: handle.location,
    bytes: handle.size,
    schemas: schemaResults.length,
  });
  return handle;
}

async function captureStorageManifest(
  store: ObjectStore | null,
  config: Context['config'],
  now: Date,
): Promise<StorageManifest | null> {
  if (store === null) return null;
  const objects = await store.list('');
  return {
    bucket: config.storage.bucket,
    captured_at: now.toISOString(),
    objects: objects.map((object) => ({
      key: object.key,
      size: object.size,
      last_modified: object.lastModified.toISOString(),
    })),
  };
}
