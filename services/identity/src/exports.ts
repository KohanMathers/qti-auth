import { randomUUIDv7 } from 'node:crypto';

import { type Bus, type BusMetrics, rpcRequest } from '@qtiauth/bus';
import { deletedRows } from '@qtiauth/db';
import { queueEmail } from '@qtiauth/email';
import {
  EXPORT_USER_METHOD,
  exportObjectKey,
  type ObjectStore,
  type UserExport,
} from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import { findAccount } from './accounts.ts';
import { exportUser } from './data-rights.ts';
import type { Database, DataExportStatus } from './database.ts';
import { iso } from './iso.ts';
import { zipFiles } from './zip.ts';

export const EXPORT_SERVICES = ['notifier', 'oidc', 'games', 'safety', 'support'] as const;
export const EXPORT_RESUME_JOB = 'accounts.resume_exports';
// An export not finished within this long is assumed abandoned (for example by a restart).
export const EXPORT_CLAIM_LEASE = 15 * 60 * 1000;

export type ExportFailure = 'account_gone' | 'collect_failed' | 'store_failed' | 'email_failed';

export interface ExportSettings {
  ttl: number;
  emailMaxBytes: number;
  defaultLocale: string;
}

export interface DataExport {
  id: string;
  status: DataExportStatus;
  download_url: string | null;
  bytes: number | null;
  expires_at: string | null;
  error: string | null;
}

function jsonFile(name: string, data: unknown): { name: string; body: Uint8Array } {
  return { name, body: new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`) };
}

function presignSeconds(ttl: number): number {
  return Math.max(1, Math.ceil(ttl / 1000));
}

function expiresInDays(ttl: number): number {
  return Math.max(1, Math.round(ttl / (24 * 60 * 60 * 1000)));
}

export async function collectExportArchive(
  db: Kysely<Database>,
  bus: Bus,
  userId: string,
  options: { metrics?: BusMetrics } = {},
): Promise<Uint8Array> {
  const identity = await exportUser(db, userId);
  const entries = [jsonFile('identity.json', identity)];
  for (const service of EXPORT_SERVICES) {
    const result = await rpcRequest<UserExport>(
      bus,
      service,
      EXPORT_USER_METHOD,
      { user_id: userId },
      options.metrics === undefined ? {} : { metrics: options.metrics },
    );
    if (result.status !== 'ok') continue;
    entries.push(jsonFile(`${result.data.service}.json`, result.data.data));
  }
  return zipFiles(entries);
}

export async function requestExport(
  db: Kysely<Database>,
  options: { userId: string; now: Date },
): Promise<{ status: 'not_found' } | { status: 'ok'; id: string }> {
  const account = await findAccount(db, options.userId);
  if (!account || account.state === 'deleted') return { status: 'not_found' };
  const id = randomUUIDv7();
  await db
    .insertInto('data_exports')
    .values({
      id,
      user_id: options.userId,
      status: 'pending',
      created_at: options.now,
    })
    .execute();
  return { status: 'ok', id };
}

async function markExport(
  db: Kysely<Database>,
  id: string,
  patch: {
    status: DataExportStatus;
    object_key?: string | null;
    bytes?: number | null;
    download_expires_at?: Date | null;
    error?: string | null;
    completed_at: Date;
  },
): Promise<void> {
  await db
    .updateTable('data_exports')
    .set({
      status: patch.status,
      object_key: patch.object_key ?? null,
      bytes: patch.bytes ?? null,
      download_expires_at: patch.download_expires_at ?? null,
      error: patch.error ?? null,
      completed_at: patch.completed_at,
    })
    .where('id', '=', id)
    .where('status', '=', 'pending')
    .execute();
}

async function claimExport(
  db: Kysely<Database>,
  exportId: string,
  now: Date,
): Promise<{ user_id: string } | undefined> {
  const staleBefore = new Date(now.getTime() - EXPORT_CLAIM_LEASE);
  return db
    .updateTable('data_exports')
    .set({ started_at: now })
    .where('id', '=', exportId)
    .where('status', '=', 'pending')
    .where((eb) => eb.or([eb('started_at', 'is', null), eb('started_at', '<=', staleBefore)]))
    .returning('user_id')
    .executeTakeFirst();
}

export interface CompleteExportOptions {
  store: ObjectStore | null;
  settings: ExportSettings;
  metrics?: BusMetrics;
  onError?: (error: unknown, code: ExportFailure) => void;
  now: Date;
}

export async function completeExport(
  db: Kysely<Database>,
  bus: Bus,
  exportId: string,
  options: CompleteExportOptions,
): Promise<DataExportStatus> {
  const claimed = await claimExport(db, exportId, options.now);
  if (claimed === undefined) {
    const row = await db
      .selectFrom('data_exports')
      .select('status')
      .where('id', '=', exportId)
      .executeTakeFirst();
    return row?.status ?? 'failed';
  }
  const userId = claimed.user_id;
  const fail = async (code: ExportFailure, error?: unknown): Promise<'failed'> => {
    if (error !== undefined) options.onError?.(error, code);
    await markExport(db, exportId, { status: 'failed', error: code, completed_at: options.now });
    return 'failed';
  };

  const account = await findAccount(db, userId);
  if (!account || account.state === 'deleted') return fail('account_gone');

  let archive: Uint8Array;
  try {
    archive = await collectExportArchive(db, bus, userId, {
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    });
  } catch (error) {
    return fail('collect_failed', error);
  }

  const locale = account.locale ?? options.settings.defaultLocale;
  const filename = `export-${userId}.zip`;

  if (options.store !== null) {
    const store = options.store;
    const key = exportObjectKey(userId, exportId);
    const expiresAt = new Date(options.now.getTime() + options.settings.ttl);
    let stored = false;
    try {
      await store.put(key, archive, 'application/zip');
      stored = true;
      const link = await store.presignGet(key, presignSeconds(options.settings.ttl));
      await queueEmail(bus, {
        template: 'data_export',
        to: { address: account.email },
        locale,
        userId,
        variables: { link, expires_in_days: expiresInDays(options.settings.ttl) },
      });
      await markExport(db, exportId, {
        status: 'ready',
        object_key: key,
        bytes: archive.byteLength,
        download_expires_at: expiresAt,
        completed_at: options.now,
      });
      return 'ready';
    } catch (error) {
      // The row never gets an object_key on failure, so sweepExports cannot find the zip later.
      if (stored) {
        await store.delete(key).catch((cleanupError: unknown) => {
          options.onError?.(cleanupError, 'store_failed');
        });
      }
      return fail('store_failed', error);
    }
  }

  if (archive.byteLength > options.settings.emailMaxBytes) {
    await markExport(db, exportId, {
      status: 'unavailable',
      bytes: archive.byteLength,
      error: 'too_large',
      completed_at: options.now,
    });
    return 'unavailable';
  }

  try {
    await queueEmail(bus, {
      template: 'data_export_attachment',
      to: { address: account.email },
      locale,
      userId,
      variables: { filename },
      attachments: [{ filename, contentType: 'application/zip', body: archive }],
    });
    await markExport(db, exportId, {
      status: 'ready',
      bytes: archive.byteLength,
      completed_at: options.now,
    });
    return 'ready';
  } catch (error) {
    return fail('email_failed', error);
  }
}

export async function resumePendingExports(
  db: Kysely<Database>,
  bus: Bus,
  options: CompleteExportOptions & { onCompleted?: (status: DataExportStatus) => void },
): Promise<number> {
  const staleBefore = new Date(options.now.getTime() - EXPORT_CLAIM_LEASE);
  const rows = await db
    .selectFrom('data_exports')
    .select('id')
    .where('status', '=', 'pending')
    .where((eb) => eb.or([eb('started_at', 'is', null), eb('started_at', '<=', staleBefore)]))
    .orderBy('created_at')
    .execute();
  let resumed = 0;
  for (const row of rows) {
    const status = await completeExport(db, bus, row.id, options);
    options.onCompleted?.(status);
    if (status !== 'pending') resumed += 1;
  }
  return resumed;
}

export async function getExport(
  db: Kysely<Database>,
  options: { userId: string; exportId: string; store: ObjectStore | null; now: Date },
): Promise<DataExport | undefined> {
  const row = await db
    .selectFrom('data_exports')
    .select(['id', 'status', 'object_key', 'bytes', 'download_expires_at', 'error'])
    .where('id', '=', options.exportId)
    .where('user_id', '=', options.userId)
    .executeTakeFirst();
  if (!row) return undefined;
  let downloadUrl: string | null = null;
  if (
    row.status === 'ready' &&
    row.object_key !== null &&
    options.store !== null &&
    row.download_expires_at !== null &&
    row.download_expires_at.getTime() > options.now.getTime()
  ) {
    downloadUrl = await options.store.presignGet(
      row.object_key,
      presignSeconds(row.download_expires_at.getTime() - options.now.getTime()),
    );
  }
  return {
    id: row.id,
    status: row.status,
    download_url: downloadUrl,
    bytes: row.bytes,
    expires_at: iso(row.download_expires_at),
    error: row.error,
  };
}

export async function sweepExports(
  db: Kysely<Database>,
  options: { store: ObjectStore | null; ttl: number; now: Date },
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.ttl);
  const rows = await db
    .selectFrom('data_exports')
    .select(['id', 'object_key'])
    .where((eb) =>
      eb.or([
        eb.and([
          eb('status', '=', 'ready'),
          eb('download_expires_at', 'is not', null),
          eb('download_expires_at', '<=', options.now),
        ]),
        eb('created_at', '<=', cutoff),
      ]),
    )
    .execute();
  if (options.store !== null) {
    for (const row of rows) {
      if (row.object_key !== null) await options.store.delete(row.object_key);
    }
  }
  if (rows.length === 0) return 0;
  const result = await db
    .deleteFrom('data_exports')
    .where(
      'id',
      'in',
      rows.map((row) => row.id),
    )
    .executeTakeFirst();
  return deletedRows(result);
}
