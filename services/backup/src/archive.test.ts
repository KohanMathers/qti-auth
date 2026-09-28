import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ArchiveFormatError, decodeHeader, encodeHeader, openChunk, sealChunk } from './archive.ts';

describe('archive header', () => {
  it('encodes and decodes a manifest length', () => {
    const header = encodeHeader(1_234);
    expect(header).toHaveLength(32);
    const parsed = decodeHeader(header);
    expect(parsed).toEqual({ version: 1, manifestLength: 1_234 });
  });

  it('rejects wrong magic', () => {
    const header = Buffer.alloc(32);
    header.write('NOPE', 0);
    expect(() => decodeHeader(header)).toThrow(ArchiveFormatError);
  });

  it('rejects a truncated header', () => {
    expect(() => decodeHeader(Buffer.alloc(8))).toThrow(/shorter than its header/);
  });
});

describe('chunks', () => {
  const key = randomBytes(32);

  it('roundtrips through sealChunk and openChunk', () => {
    const plaintext = Buffer.from('the licence is under the flowerpot');
    const chunk = sealChunk(key, 'aad', plaintext);
    expect(openChunk(key, 'aad', chunk)).toEqual(plaintext);
  });

  it('rejects a chunk under the wrong aad', () => {
    const chunk = sealChunk(key, 'aad-a', Buffer.from('hello'));
    expect(() => openChunk(key, 'aad-b', chunk)).toThrow();
  });

  it('rejects a chunk under the wrong key', () => {
    const chunk = sealChunk(key, 'aad', Buffer.from('hello'));
    expect(() => openChunk(randomBytes(32), 'aad', chunk)).toThrow();
  });
});
