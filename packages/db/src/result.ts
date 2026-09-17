import type { DeleteResult } from 'kysely';

export function deletedRows(result: readonly DeleteResult[]): number {
  return result.reduce((total, row) => total + Number(row.numDeletedRows), 0);
}
