import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { QtiauthConfig } from '@qtiauth/config';
import { LEDGER_OBJECT_PREFIX, ledgerObjectKey, type ObjectStore } from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import type { Database } from './database.ts';
import { IdentityConfigError } from './settings.ts';

export const LEDGER_PRUNE_JOB = 'deletion_ledger.prune';
export const LEDGER_EXTRA_RETENTION = 30 * 24 * 60 * 60 * 1000;

export interface LedgerEntry {
  user_id: string;
  deleted_at: string;
}

export type LedgerDestination =
  { kind: 'directory'; directory: string } | { kind: 'storage'; store: ObjectStore };

export function ledgerDestination(
  backups: QtiauthConfig['backups'],
  store: ObjectStore | null,
): LedgerDestination {
  if (backups.destination === 'storage') {
    if (store === null) {
      throw new IdentityConfigError('backups.destination is storage but storage is not enabled');
    }
    return { kind: 'storage', store };
  }
  return { kind: 'directory', directory: backups.directory };
}

export function ledgerKeepUntil(retention: number, now: Date): Date {
  return new Date(now.getTime() - retention - LEDGER_EXTRA_RETENTION);
}

function entryBytes(entry: LedgerEntry): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(entry)}\n`);
}

function parseEntry(body: string): LedgerEntry | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('user_id' in parsed) ||
      !('deleted_at' in parsed) ||
      typeof parsed.user_id !== 'string' ||
      typeof parsed.deleted_at !== 'string'
    ) {
      return undefined;
    }
    return { user_id: parsed.user_id, deleted_at: parsed.deleted_at };
  } catch {
    return undefined;
  }
}

async function writeDestination(destination: LedgerDestination, entry: LedgerEntry): Promise<void> {
  const body = entryBytes(entry);
  if (destination.kind === 'storage') {
    await destination.store.put(ledgerObjectKey(entry.user_id), body, 'application/json');
    return;
  }
  const dir = join(destination.directory, 'deletion-ledger');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${entry.user_id}.json`), body);
}

export async function enqueueLedgerEntry(
  db: Kysely<Database>,
  options: { userId: string; deletedAt: Date },
): Promise<void> {
  await db
    .insertInto('deletion_ledger_outbox')
    .values({ user_id: options.userId, deleted_at: options.deletedAt })
    .onConflict((conflict) => conflict.columns(['user_id']).doNothing())
    .execute();
}

export async function flushLedgerOutbox(
  db: Kysely<Database>,
  destination: LedgerDestination,
  now: Date,
): Promise<number> {
  const rows = await db
    .selectFrom('deletion_ledger_outbox')
    .select(['id', 'user_id', 'deleted_at'])
    .where('sent_at', 'is', null)
    .orderBy('id')
    .execute();
  let sent = 0;
  for (const row of rows) {
    await writeDestination(destination, {
      user_id: row.user_id,
      deleted_at: row.deleted_at.toISOString(),
    });
    await db
      .updateTable('deletion_ledger_outbox')
      .set({ sent_at: now })
      .where('id', '=', row.id)
      .where('sent_at', 'is', null)
      .execute();
    sent += 1;
  }
  return sent;
}

export async function pruneLedgerDestination(
  destination: LedgerDestination,
  cutoff: Date,
): Promise<number> {
  if (destination.kind === 'storage') {
    const objects = await destination.store.list(LEDGER_OBJECT_PREFIX);
    let deleted = 0;
    for (const object of objects) {
      if (object.lastModified.getTime() > cutoff.getTime()) continue;
      await destination.store.delete(object.key);
      deleted += 1;
    }
    return deleted;
  }
  const dir = join(destination.directory, 'deletion-ledger');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let deleted = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    const [info, body] = await Promise.all([stat(path), readFile(path, 'utf8')]);
    const entry = parseEntry(body);
    const when = entry === undefined ? info.mtime : new Date(entry.deleted_at);
    if (Number.isNaN(when.getTime()) || when.getTime() > cutoff.getTime()) continue;
    await rm(path);
    deleted += 1;
  }
  return deleted;
}

export async function sweepLedgerOutbox(db: Kysely<Database>, cutoff: Date): Promise<number> {
  const result = await db
    .deleteFrom('deletion_ledger_outbox')
    .where('sent_at', 'is not', null)
    .where('sent_at', '<=', cutoff)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
