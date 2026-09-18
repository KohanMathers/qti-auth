import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { zipFiles } from './zip.ts';

describe('zipFiles', () => {
  it('packs JSON files a zip tool can inflate', () => {
    const identity = new TextEncoder().encode('{"email":"a@example.com"}');
    const zip = zipFiles(
      [
        { name: 'identity.json', body: identity },
        { name: 'notifier.json', body: new TextEncoder().encode('{"ok":true}') },
      ],
      new Date('2026-09-18T12:00:00Z'),
    );
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    const name = new TextEncoder().encode('identity.json');
    const nameAt = indexOf(zip, name);
    expect(nameAt).toBeGreaterThan(0);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const compressedSize = view.getUint32(nameAt - 12, true);
    const uncompressedSize = view.getUint32(nameAt - 8, true);
    const dataStart = nameAt + name.byteLength;
    const inflated = inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize));
    expect(uncompressedSize).toBe(identity.byteLength);
    expect(Buffer.from(inflated).equals(Buffer.from(identity))).toBe(true);
  });
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
