import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ARCHIVE_MAGIC = Buffer.from('QTIBAK\0\0', 'ascii');
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_HEADER_LENGTH = 32;
export const IV_LENGTH = 12;
export const TAG_LENGTH = 16;
export const CHUNK_LENGTH_BYTES = 4;
export const KEY_LENGTH = 32;
export const AAD_MANIFEST = 'qtiauth-backup-manifest-v1';
export const AAD_BLOB_PREFIX = 'qtiauth-backup-blob-v1:';

export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveFormatError';
  }
}

// | 8 bytes magic | 4 bytes version (BE) | 4 bytes manifest length (BE) | 16 bytes reserved |
export function encodeHeader(manifestLength: number): Buffer {
  const header = Buffer.alloc(ARCHIVE_HEADER_LENGTH);
  ARCHIVE_MAGIC.copy(header, 0);
  header.writeUInt32BE(ARCHIVE_VERSION, 8);
  header.writeUInt32BE(manifestLength, 12);
  return header;
}

export interface ParsedHeader {
  version: number;
  manifestLength: number;
}

export function decodeHeader(bytes: Buffer): ParsedHeader {
  if (bytes.length < ARCHIVE_HEADER_LENGTH) {
    throw new ArchiveFormatError('Backup is shorter than its header');
  }
  if (!bytes.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) {
    throw new ArchiveFormatError('Not a QTIAuth backup (bad magic)');
  }
  const version = bytes.readUInt32BE(8);
  if (version !== ARCHIVE_VERSION) {
    throw new ArchiveFormatError(`Unsupported backup version ${String(version)}`);
  }
  return { version, manifestLength: bytes.readUInt32BE(12) };
}

// | 12 bytes iv | 4 bytes ciphertext length (BE) | ciphertext | 16 bytes tag |
export function sealChunk(key: Buffer, aad: string, plaintext: Uint8Array): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const length = Buffer.alloc(CHUNK_LENGTH_BYTES);
  length.writeUInt32BE(ciphertext.length, 0);
  return Buffer.concat([iv, length, ciphertext, tag]);
}

export function openChunk(key: Buffer, aad: string, chunk: Buffer): Buffer {
  const iv = chunk.subarray(0, IV_LENGTH);
  const length = chunk.readUInt32BE(IV_LENGTH);
  const ciphertext = chunk.subarray(
    IV_LENGTH + CHUNK_LENGTH_BYTES,
    IV_LENGTH + CHUNK_LENGTH_BYTES + length,
  );
  const tag = chunk.subarray(
    IV_LENGTH + CHUNK_LENGTH_BYTES + length,
    IV_LENGTH + CHUNK_LENGTH_BYTES + length + TAG_LENGTH,
  );
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function blobAad(archiveId: string, path: string): string {
  return `${AAD_BLOB_PREFIX}${archiveId}\0${path}`;
}

export function chunkOverhead(): number {
  return IV_LENGTH + CHUNK_LENGTH_BYTES + TAG_LENGTH;
}

export interface ChunkFrame {
  frameLength: number;
  ciphertextLength: number;
}

export function readChunkFrame(bytes: Buffer, offset: number): ChunkFrame {
  if (offset + IV_LENGTH + CHUNK_LENGTH_BYTES > bytes.length) {
    throw new ArchiveFormatError('Backup ends inside a chunk header');
  }
  const ciphertextLength = bytes.readUInt32BE(offset + IV_LENGTH);
  const frameLength = IV_LENGTH + CHUNK_LENGTH_BYTES + ciphertextLength + TAG_LENGTH;
  if (offset + frameLength > bytes.length) {
    throw new ArchiveFormatError('Backup ends inside a chunk body');
  }
  return { frameLength, ciphertextLength };
}
