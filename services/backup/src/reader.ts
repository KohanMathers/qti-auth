import {
  AAD_MANIFEST,
  ARCHIVE_HEADER_LENGTH,
  ArchiveFormatError,
  blobAad,
  decodeHeader,
  openChunk,
  readChunkFrame,
} from './archive.ts';
import { decodeJson, type Manifest, manifestSchema } from './manifest.ts';

export interface OpenedArchive {
  manifest: Manifest;
  readBlob: (path: string) => Buffer;
}

export function openArchive(archive: Buffer, key: Buffer): OpenedArchive {
  const header = decodeHeader(archive);
  const manifestFrameStart = ARCHIVE_HEADER_LENGTH;
  const manifestFrameEnd = manifestFrameStart + header.manifestLength;
  if (manifestFrameEnd > archive.length) {
    throw new ArchiveFormatError('Backup ends inside the manifest chunk');
  }
  const manifestChunk = archive.subarray(manifestFrameStart, manifestFrameEnd);
  const manifestBytes = openChunk(key, AAD_MANIFEST, manifestChunk);
  const manifest = manifestSchema.parse(decodeJson(manifestBytes));

  const cache = new Map<string, Buffer>();
  const paths = new Map<string, number>();
  for (const entry of manifest.schemas) {
    paths.set(entry.path, entry.chunks);
  }
  paths.set('storage-manifest.json', -1);

  let offset = manifestFrameEnd;
  for (const [path, expected] of paths) {
    const aad = blobAad(manifest.archive_id, path);
    const parts: Buffer[] = [];
    let count = 0;
    const target = expected < 0 ? 1 : expected;
    while (count < target) {
      if (offset >= archive.length) {
        if (expected < 0 && count === 0) break;
        throw new ArchiveFormatError(`Backup ended before blob ${path} was read`);
      }
      const frame = readChunkFrame(archive, offset);
      const chunk = archive.subarray(offset, offset + frame.frameLength);
      parts.push(openChunk(key, aad, chunk));
      offset += frame.frameLength;
      count += 1;
    }
    if (parts.length > 0) cache.set(path, Buffer.concat(parts));
  }
  if (offset !== archive.length) {
    throw new ArchiveFormatError('Backup has trailing bytes after the last blob');
  }

  const readBlob = (path: string): Buffer => {
    const bytes = cache.get(path);
    if (bytes === undefined) {
      throw new ArchiveFormatError(`Backup does not contain blob ${path}`);
    }
    return bytes;
  };

  return { manifest, readBlob };
}
