import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { openArchive } from './reader.ts';
import { createArchiveDraft, encodeStorageManifest } from './writer.ts';

const key = randomBytes(32);

const manifestFor = (
  archiveId: string,
  schemas: { schema: string; result: { path: string; chunks: number; plaintextBytes: number } }[],
) => ({
  archive_id: archiveId,
  created_at: '2026-09-28T00:00:00.000Z',
  database: 'qtiauth',
  schemas: schemas.map(({ schema, result }) => ({
    schema,
    path: result.path,
    chunks: result.chunks,
    plaintext_bytes: result.plaintextBytes,
    pg_dump_version: 'pg_dump (PostgreSQL) 18.0',
  })),
  storage: { bucket: null, object_count: 0, total_bytes: 0 },
  postgres_version: 'PostgreSQL 18.0',
  service_versions: { backup: '0.0.0' },
});

describe('archive writer and reader', () => {
  it('roundtrips a single-blob archive', async () => {
    const draft = createArchiveDraft({ archiveId: 'archive-1', key, chunkSize: 32 });
    const blob = draft.openBlob('schemas/identity.dump');
    const payload = Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(6));
    await blob.push(payload);
    const result = await blob.finish();
    expect(result.plaintextBytes).toBe(payload.length);
    expect(result.chunks).toBeGreaterThan(1);

    const storageBlob = draft.openBlob('storage-manifest.json');
    await storageBlob.finish();

    const body = draft.finalize(manifestFor('archive-1', [{ schema: 'identity', result }]));

    const opened = openArchive(body, key);
    expect(opened.manifest.archive_id).toBe('archive-1');
    expect(opened.readBlob('schemas/identity.dump')).toEqual(payload);
  });

  it('carries the storage manifest through the archive', async () => {
    const draft = createArchiveDraft({ archiveId: 'archive-2', key, chunkSize: 256 });
    const schemaBlob = draft.openBlob('schemas/notify.dump');
    await schemaBlob.push(Buffer.from('notify'));
    const schemaResult = await schemaBlob.finish();

    const storageBlob = draft.openBlob('storage-manifest.json');
    const storageBytes = encodeStorageManifest({
      bucket: 'qtiauth',
      captured_at: '2026-09-28T00:00:00.000Z',
      objects: [
        { key: 'attachments/1.png', size: 1_024, last_modified: '2026-09-27T12:00:00.000Z' },
      ],
    });
    await storageBlob.push(storageBytes);
    await storageBlob.finish();

    const body = draft.finalize(
      manifestFor('archive-2', [{ schema: 'notify', result: schemaResult }]),
    );
    const opened = openArchive(body, key);
    expect(opened.readBlob('storage-manifest.json').toString('utf8')).toContain(
      'attachments/1.png',
    );
  });

  it('rejects a tampered ciphertext', async () => {
    const draft = createArchiveDraft({ archiveId: 'archive-3', key, chunkSize: 64 });
    const blob = draft.openBlob('schemas/identity.dump');
    await blob.push(Buffer.from('hello'));
    const result = await blob.finish();
    const storageBlob = draft.openBlob('storage-manifest.json');
    await storageBlob.finish();
    const body = draft.finalize(manifestFor('archive-3', [{ schema: 'identity', result }]));

    const last = body[body.length - 1] ?? 0;
    body[body.length - 1] = last ^ 0xff;
    expect(() => openArchive(body, key)).toThrow();
  });
});
