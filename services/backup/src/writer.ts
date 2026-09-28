import { blobAad, chunkOverhead, encodeHeader, sealChunk } from './archive.ts';
import { AAD_MANIFEST } from './archive.ts';
import { encodeJson, type Manifest, type StorageManifest } from './manifest.ts';

export interface BlobWriter {
  path: string;
  push: (chunk: Uint8Array) => Promise<void>;
  finish: () => Promise<BlobResult>;
}

export interface BlobResult {
  path: string;
  chunks: number;
  plaintextBytes: number;
}

export interface ArchiveDraft {
  archiveId: string;
  openBlob: (path: string) => BlobWriter;
  finalize: (manifest: Manifest) => Buffer;
}

export function createArchiveDraft(options: {
  archiveId: string;
  key: Buffer;
  chunkSize: number;
}): ArchiveDraft {
  const parts: Buffer[] = [];
  const blobs = new Map<string, BlobResult>();

  const openBlob = (path: string): BlobWriter => {
    if (blobs.has(path)) {
      throw new Error(`Blob ${path} already open in this archive`);
    }
    const aad = blobAad(options.archiveId, path);
    let pending = Buffer.alloc(0);
    let chunks = 0;
    let plaintextBytes = 0;

    const flushFull = (): void => {
      while (pending.length >= options.chunkSize) {
        const plaintext = pending.subarray(0, options.chunkSize);
        parts.push(sealChunk(options.key, aad, plaintext));
        pending = pending.subarray(options.chunkSize);
        chunks += 1;
      }
    };

    return {
      path,
      push: (chunk) => {
        plaintextBytes += chunk.byteLength;
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        flushFull();
        return Promise.resolve();
      },
      finish: () => {
        if (pending.length > 0) {
          parts.push(sealChunk(options.key, aad, pending));
          chunks += 1;
          pending = Buffer.alloc(0);
        }
        const result = { path, chunks, plaintextBytes };
        blobs.set(path, result);
        return Promise.resolve(result);
      },
    };
  };

  const finalize = (manifest: Manifest): Buffer => {
    const manifestBytes = encodeJson(manifest);
    const sealedManifest = sealChunk(options.key, AAD_MANIFEST, manifestBytes);
    const header = encodeHeader(sealedManifest.length);
    return Buffer.concat([header, sealedManifest, ...parts]);
  };

  return { archiveId: options.archiveId, openBlob, finalize };
}

export function encodeStorageManifest(manifest: StorageManifest): Buffer {
  return encodeJson(manifest);
}

export function estimateChunkedSize(plaintextBytes: number, chunkSize: number): number {
  const fullChunks = Math.floor(plaintextBytes / chunkSize);
  const remainder = plaintextBytes - fullChunks * chunkSize;
  const chunks = fullChunks + (remainder > 0 ? 1 : 0);
  return plaintextBytes + chunks * chunkOverhead();
}
