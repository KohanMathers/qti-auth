import * as z from 'zod';

export const manifestSchema = z.strictObject({
  archive_id: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }),
  database: z.string().min(1),
  schemas: z
    .array(
      z.strictObject({
        schema: z.string().min(1),
        path: z.string().min(1),
        chunks: z.number().int().min(0),
        plaintext_bytes: z.number().int().min(0),
        pg_dump_version: z.string().min(1),
      }),
    )
    .min(1),
  storage: z.strictObject({
    bucket: z.string().nullable(),
    object_count: z.number().int().min(0),
    total_bytes: z.number().int().min(0),
  }),
  postgres_version: z.string().min(1),
  service_versions: z.record(z.string(), z.string()),
});

export type Manifest = z.output<typeof manifestSchema>;

export const storageManifestSchema = z.strictObject({
  bucket: z.string().min(1),
  captured_at: z.iso.datetime({ offset: true }),
  objects: z.array(
    z.strictObject({
      key: z.string().min(1),
      size: z.number().int().min(0),
      last_modified: z.iso.datetime({ offset: true }),
    }),
  ),
});

export type StorageManifest = z.output<typeof storageManifestSchema>;

export const STORAGE_MANIFEST_BLOB_PATH = 'storage-manifest.json';

export function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

export function decodeJson(bytes: Buffer | Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
}
