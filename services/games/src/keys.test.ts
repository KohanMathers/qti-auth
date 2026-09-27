import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  batchCsv,
  csvRow,
  formatDescriptor,
  generateCode,
  hashCode,
  type KeyBatchRecord,
  type KeyFormat,
  maskCode,
  normalizeCode,
  openCode,
  sealCode,
} from './keys.ts';

const FORMAT: KeyFormat = {
  charset: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  group_length: 4,
  groups: 4,
};

describe('key format helpers', () => {
  it('produces a stable descriptor', () => {
    expect(formatDescriptor(FORMAT)).toBe('4x4');
  });

  it('generates codes matching the format and charset', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = generateCode(FORMAT);
      const parts = code.split('-');
      expect(parts).toHaveLength(FORMAT.groups);
      for (const part of parts) {
        expect(part).toHaveLength(FORMAT.group_length);
        for (let index = 0; index < part.length; index++) {
          expect(FORMAT.charset).toContain(part.charAt(index));
        }
      }
    }
  });

  it('normalizes whitespace, hyphens and case before hashing', () => {
    const a = normalizeCode('  aaaa-bbbb-cccc-dddd  ');
    const b = normalizeCode('AAAA BBBB CCCC DDDD');
    expect(a).toBe('AAAABBBBCCCCDDDD');
    expect(a).toBe(b);
    expect(Buffer.from(hashCode('aaaa-bbbb-cccc-dddd')).toString('hex')).toBe(
      Buffer.from(hashCode('AAAABBBBCCCCDDDD')).toString('hex'),
    );
  });

  it('masks all groups after the first', () => {
    expect(maskCode('ABCD-EFGH-JKMN-PQRS', FORMAT)).toBe('ABCD-****-****-****');
  });
});

describe('sealed codes', () => {
  const key = randomBytes(32);

  it('round-trips through seal and open with the batch id as AAD', () => {
    const sealed = sealCode('ABCD-EFGH-JKMN-PQRS', key, 'batch-1');
    expect(openCode(sealed, key, 'batch-1')).toBe('ABCD-EFGH-JKMN-PQRS');
  });

  it('rejects a sealed code opened under a different batch id', () => {
    const sealed = sealCode('ABCD-EFGH-JKMN-PQRS', key, 'batch-1');
    expect(() => openCode(sealed, key, 'batch-2')).toThrow();
  });
});

describe('csv output', () => {
  it('quotes fields that contain commas, quotes or newlines', () => {
    expect(csvRow(['plain', 'a,b', 'she said "hi"', 'line1\nline2', null])).toBe(
      'plain,"a,b","she said ""hi""","line1\nline2",\r\n',
    );
  });

  it('emits code, display, status and redeemed_at columns', () => {
    const batch: KeyBatchRecord = {
      id: 'b',
      game_id: 'g',
      product_id: 'p',
      label: 'press',
      format: '4x4',
      total_keys: 3,
      expires_at: null,
      created_by: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
      revoked_at: null,
      revoke_reason: null,
    };
    const csv = batchCsv(
      batch,
      [
        {
          code: 'AAAA-BBBB-CCCC-DDDD',
          display: 'AAAA-****-****-****',
          redeemed_at: new Date('2026-02-01T00:00:00Z'),
          revoked_at: null,
        },
        {
          code: 'WWWW-XXXX-YYYY-ZZZZ',
          display: 'WWWW-****-****-****',
          redeemed_at: null,
          revoked_at: null,
        },
      ],
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(csv.split('\r\n').filter((line) => line !== '')).toEqual([
      'code,display,status,redeemed_at',
      'AAAA-BBBB-CCCC-DDDD,AAAA-****-****-****,redeemed,2026-02-01T00:00:00.000Z',
      'WWWW-XXXX-YYYY-ZZZZ,WWWW-****-****-****,unused,',
    ]);
  });
});
