import type { Kysely } from 'kysely';

export function inTransaction<DB, T>(
  db: Kysely<DB>,
  fn: (trx: Kysely<DB>) => Promise<T>,
): Promise<T> {
  return db.isTransaction ? fn(db) : db.transaction().execute(fn);
}
