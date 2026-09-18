import type { DeleteResult, UpdateResult } from 'kysely';

export function deletedRows(result: DeleteResult | readonly DeleteResult[]): number {
  const rows = 'numDeletedRows' in result ? [result] : result;
  return rows.reduce((total, row) => total + Number(row.numDeletedRows), 0);
}

export function updatedRows(result: UpdateResult | readonly UpdateResult[]): number {
  const rows = 'numUpdatedRows' in result ? [result] : result;
  return rows.reduce((total, row) => total + Number(row.numUpdatedRows), 0);
}
