import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { decodeCursor, encodeCursor, pageOf, paginationQuery } from './pagination.ts';

const position = z.object({ created_at: z.iso.datetime(), id: z.string() });

describe('cursors', () => {
  it('round-trips a position', () => {
    const cursor = encodeCursor({ created_at: '2026-09-16T12:00:00Z', id: 'a' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(position, cursor)).toEqual({ created_at: '2026-09-16T12:00:00Z', id: 'a' });
    expect(decodeCursor(position, undefined)).toBeUndefined();
  });

  it.each([
    ['not base64url', 'a+b/c='],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    ['the wrong shape', encodeCursor({ id: 1 })],
    ['too long', 'a'.repeat(2000)],
  ])('rejects a cursor that is %s', (_, cursor) => {
    expect(() => decodeCursor(position, cursor)).toThrow(
      expect.objectContaining({ code: 'INVALID_CURSOR' }),
    );
  });
});

describe('pageOf', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('returns a cursor when there are more rows than the limit', () => {
    const page = pageOf(rows, 2, (row) => ({ id: row.id }));
    expect(page.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(
      page.next_cursor && decodeCursor(z.object({ id: z.string() }), page.next_cursor),
    ).toEqual({ id: 'b' });
  });

  it('returns no cursor on the last page', () => {
    expect(pageOf(rows, 3, (row) => row.id)).toEqual({ items: rows, next_cursor: null });
  });
});

describe('paginationQuery', () => {
  it('coerces and bounds the limit', () => {
    const query = paginationQuery({ defaultLimit: 20, maxLimit: 50 });
    expect(query.parse({})).toEqual({ limit: 20 });
    expect(query.parse({ limit: '5', cursor: 'abc' })).toEqual({ limit: 5, cursor: 'abc' });
    expect(query.safeParse({ limit: '51' }).success).toBe(false);
    expect(query.safeParse({ limit: '0' }).success).toBe(false);
  });
});
