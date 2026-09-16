import * as z from 'zod';

import { ProblemError } from './problems.ts';

export const MAX_CURSOR_LENGTH = 1024;

export interface PaginationLimits {
  defaultLimit?: number;
  maxLimit?: number;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export function paginationQuery({ defaultLimit = 50, maxLimit = 100 }: PaginationLimits = {}) {
  return z.object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(maxLimit)
      .default(defaultLimit)
      .describe(`Items per page, up to ${String(maxLimit)}.`),
    cursor: z
      .string()
      .min(1)
      .max(MAX_CURSOR_LENGTH)
      .optional()
      .describe('next_cursor from the previous page. Leave out for the first page.'),
  });
}

export function pageSchema<S extends z.ZodType>(item: S) {
  return z.object({
    items: z.array(item),
    next_cursor: z
      .string()
      .nullable()
      .describe('Pass as cursor to get the next page. null on the last page.'),
  });
}

export function encodeCursor(position: unknown): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

export function decodeCursor<S extends z.ZodType>(
  schema: S,
  cursor: string | undefined,
): z.output<S> | undefined {
  if (cursor === undefined) return undefined;
  const invalid = () => new ProblemError('INVALID_CURSOR');
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}

export function pageOf<T>(
  rows: readonly T[],
  limit: number,
  positionOf: (last: T) => unknown,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor: rows.length > limit && last !== undefined ? encodeCursor(positionOf(last)) : null,
  };
}
