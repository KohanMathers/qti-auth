import { inflateRawSync } from 'node:zlib';

const LOCAL = 0x04_03_4b_50;
const CENTRAL = 0x02_01_4b_50;
const EOCD = 0x06_05_4b_50;

function u16(buffer: Uint8Array, offset: number): number {
  return (buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8);
}

function u32(buffer: Uint8Array, offset: number): number {
  return u16(buffer, offset) + u16(buffer, offset + 2) * 0x1_00_00;
}

export function unzip(buffer: Uint8Array): Map<string, Uint8Array> {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (u32(buffer, i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive');

  const files = new Map<string, Uint8Array>();
  const entries = u16(buffer, eocd + 10);
  let offset = u32(buffer, eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (u32(buffer, offset) !== CENTRAL) throw new Error('Broken zip archive');
    const method = u16(buffer, offset + 10);
    const compressedSize = u32(buffer, offset + 20);
    const nameLen = u16(buffer, offset + 28);
    const extraLen = u16(buffer, offset + 30);
    const commentLen = u16(buffer, offset + 32);
    const localOffset = u32(buffer, offset + 42);
    const name = new TextDecoder().decode(buffer.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (u32(buffer, localOffset) !== LOCAL) throw new Error('Broken zip archive');
    const localNameLen = u16(buffer, localOffset + 26);
    const localExtraLen = u16(buffer, localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : undefined;
    if (data === undefined) throw new Error(`Unsupported zip compression ${String(method)}`);
    files.set(name, data);
  }
  return files;
}
