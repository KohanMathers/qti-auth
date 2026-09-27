import { randomUUID } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import { updatedRows } from '@qtiauth/db';
import type { EventActor } from '@qtiauth/events';
import { cloudSaveObjectKey, cloudSaveSlotPrefix, type ObjectStore } from '@qtiauth/service-kit';
import type { Kysely, Selectable } from 'kysely';

import type { CloudSaveSlotsTable, CloudSaveVersionsTable, Database } from './database.ts';
import {
  type AuditRecordedData,
  auditRecordedEvent,
  type CloudSaveCommittedData,
  cloudSaveCommittedEvent,
  type CloudSaveDeletedData,
  cloudSaveDeletedEvent,
} from './events.ts';

export interface CloudSaveSlotRecord {
  id: string;
  user_id: string;
  game_id: string;
  slot: string;
  current_version_id: string | null;
  size_bytes: number;
  created_at: Date;
  updated_at: Date;
}

export interface CloudSaveVersionRecord {
  id: string;
  slot_id: string;
  version: number;
  size_bytes: number;
  object_key: string;
  content_type: string;
  committed_at: Date | null;
  created_at: Date;
}

export interface SlotView {
  slot: CloudSaveSlotRecord;
  current: CloudSaveVersionRecord | null;
}

function bigint(value: string | number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function slotRecord(row: Selectable<CloudSaveSlotsTable>): CloudSaveSlotRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    game_id: row.game_id,
    slot: row.slot,
    current_version_id: row.current_version_id,
    size_bytes: bigint(row.size_bytes),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function versionRecord(row: Selectable<CloudSaveVersionsTable>): CloudSaveVersionRecord {
  return {
    id: row.id,
    slot_id: row.slot_id,
    version: row.version,
    size_bytes: bigint(row.size_bytes),
    object_key: row.object_key,
    content_type: row.content_type,
    committed_at: row.committed_at,
    created_at: row.created_at,
  };
}

async function writeAudit(
  db: Kysely<Database>,
  actor: EventActor,
  action: string,
  targetId: string,
): Promise<void> {
  await writeEvent<Database, AuditRecordedData>(
    db,
    auditRecordedEvent(actor, {
      action,
      target_type: 'cloud_save_slot',
      target_id: targetId,
    }),
  );
}

async function currentVersion(
  db: Kysely<Database>,
  slot: CloudSaveSlotRecord,
): Promise<CloudSaveVersionRecord | null> {
  if (slot.current_version_id === null) return null;
  const row = await db
    .selectFrom('cloud_save_versions')
    .selectAll()
    .where('id', '=', slot.current_version_id)
    .executeTakeFirst();
  return row ? versionRecord(row) : null;
}

async function slotView(db: Kysely<Database>, slot: CloudSaveSlotRecord): Promise<SlotView> {
  return { slot, current: await currentVersion(db, slot) };
}

export async function listSlots(
  db: Kysely<Database>,
  options: { userId: string; gameId: string },
): Promise<SlotView[]> {
  const rows = await db
    .selectFrom('cloud_save_slots')
    .selectAll()
    .where('user_id', '=', options.userId)
    .where('game_id', '=', options.gameId)
    .orderBy('updated_at', 'desc')
    .orderBy('slot', 'asc')
    .execute();
  const slots = rows.map(slotRecord);
  return Promise.all(slots.map((slot) => slotView(db, slot)));
}

export async function getSlot(
  db: Kysely<Database>,
  options: { userId: string; gameId: string; slot: string },
): Promise<SlotView | undefined> {
  const row = await db
    .selectFrom('cloud_save_slots')
    .selectAll()
    .where('user_id', '=', options.userId)
    .where('game_id', '=', options.gameId)
    .where('slot', '=', options.slot)
    .executeTakeFirst();
  if (!row) return undefined;
  return slotView(db, slotRecord(row));
}

export async function listVersions(
  db: Kysely<Database>,
  slotId: string,
): Promise<CloudSaveVersionRecord[]> {
  const rows = await db
    .selectFrom('cloud_save_versions')
    .selectAll()
    .where('slot_id', '=', slotId)
    .where('committed_at', 'is not', null)
    .orderBy('version', 'desc')
    .execute();
  return rows.map(versionRecord);
}

export async function getVersion(
  db: Kysely<Database>,
  options: { slotId: string; version: number },
): Promise<CloudSaveVersionRecord | undefined> {
  const row = await db
    .selectFrom('cloud_save_versions')
    .selectAll()
    .where('slot_id', '=', options.slotId)
    .where('version', '=', options.version)
    .executeTakeFirst();
  return row ? versionRecord(row) : undefined;
}

async function slotCountForGame(
  db: Kysely<Database>,
  options: { userId: string; gameId: string },
): Promise<number> {
  const row = await db
    .selectFrom('cloud_save_slots')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('user_id', '=', options.userId)
    .where('game_id', '=', options.gameId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export type StartUploadOutcome =
  | { status: 'ok'; slot: CloudSaveSlotRecord; version: CloudSaveVersionRecord }
  | { status: 'slot_limit' }
  | { status: 'quota' }
  | { status: 'conflict'; current: CloudSaveVersionRecord | null };

export interface StartUploadOptions {
  userId: string;
  gameId: string;
  slot: string;
  sizeBytes: number;
  contentType: string;
  baseVersion: number | null;
  quotaBytes: number;
  maxSlots: number;
  now: Date;
}

export async function startUpload(
  db: Kysely<Database>,
  options: StartUploadOptions,
): Promise<StartUploadOutcome> {
  return db.transaction().execute(async (trx) => {
    const existingRow = await trx
      .selectFrom('cloud_save_slots')
      .selectAll()
      .where('user_id', '=', options.userId)
      .where('game_id', '=', options.gameId)
      .where('slot', '=', options.slot)
      .executeTakeFirst();
    let slot: CloudSaveSlotRecord;
    let current: CloudSaveVersionRecord | null = null;
    if (existingRow) {
      slot = slotRecord(existingRow);
      current = await currentVersion(trx, slot);
    } else {
      if ((await slotCountForGame(trx, options)) >= options.maxSlots) {
        return { status: 'slot_limit' as const };
      }
      const slotId = randomUUID();
      await trx
        .insertInto('cloud_save_slots')
        .values({
          id: slotId,
          user_id: options.userId,
          game_id: options.gameId,
          slot: options.slot,
          current_version_id: null,
          size_bytes: '0',
          created_at: options.now,
          updated_at: options.now,
        })
        .execute();
      slot = {
        id: slotId,
        user_id: options.userId,
        game_id: options.gameId,
        slot: options.slot,
        current_version_id: null,
        size_bytes: 0,
        created_at: options.now,
        updated_at: options.now,
      };
    }
    const currentVersionNumber = current?.version ?? 0;
    if (options.baseVersion !== null && options.baseVersion !== currentVersionNumber) {
      return { status: 'conflict' as const, current };
    }
    const quotaRows = await trx
      .selectFrom('cloud_save_slots')
      .select('size_bytes')
      .where('user_id', '=', options.userId)
      .where('game_id', '=', options.gameId)
      .where('id', '!=', slot.id)
      .execute();
    const otherBytes = quotaRows.reduce((total, row) => total + Number(row.size_bytes), 0);
    if (otherBytes + options.sizeBytes > options.quotaBytes) {
      return { status: 'quota' as const };
    }
    const versionId = randomUUID();
    const nextVersion = currentVersionNumber + 1;
    const objectKey = cloudSaveObjectKey(options.userId, options.gameId, options.slot, versionId);
    await trx
      .insertInto('cloud_save_versions')
      .values({
        id: versionId,
        slot_id: slot.id,
        version: nextVersion,
        size_bytes: String(options.sizeBytes),
        object_key: objectKey,
        content_type: options.contentType,
        committed_at: null,
        created_at: options.now,
      })
      .execute();
    return {
      status: 'ok' as const,
      slot,
      version: {
        id: versionId,
        slot_id: slot.id,
        version: nextVersion,
        size_bytes: options.sizeBytes,
        object_key: objectKey,
        content_type: options.contentType,
        committed_at: null,
        created_at: options.now,
      },
    };
  });
}

export type CommitOutcome =
  | { status: 'ok'; slot: CloudSaveSlotRecord; version: CloudSaveVersionRecord; pruned: string[] }
  | { status: 'not_found' }
  | { status: 'already_committed' };

export async function commitUpload(
  db: Kysely<Database>,
  options: {
    userId: string;
    gameId: string;
    slot: string;
    versionId: string;
    versionsPerSlot: number;
    actor: EventActor;
    now: Date;
  },
): Promise<CommitOutcome> {
  return db.transaction().execute(async (trx) => {
    const slotRow = await trx
      .selectFrom('cloud_save_slots')
      .selectAll()
      .where('user_id', '=', options.userId)
      .where('game_id', '=', options.gameId)
      .where('slot', '=', options.slot)
      .executeTakeFirst();
    if (!slotRow) return { status: 'not_found' as const };
    const versionRow = await trx
      .selectFrom('cloud_save_versions')
      .selectAll()
      .where('id', '=', options.versionId)
      .where('slot_id', '=', slotRow.id)
      .executeTakeFirst();
    if (!versionRow) return { status: 'not_found' as const };
    if (versionRow.committed_at !== null) return { status: 'already_committed' as const };
    const result = await trx
      .updateTable('cloud_save_versions')
      .set({ committed_at: options.now })
      .where('id', '=', versionRow.id)
      .where('committed_at', 'is', null)
      .executeTakeFirst();
    if (updatedRows(result) !== 1) return { status: 'already_committed' as const };
    await trx
      .updateTable('cloud_save_slots')
      .set({
        current_version_id: versionRow.id,
        size_bytes: versionRow.size_bytes,
        updated_at: options.now,
      })
      .where('id', '=', slotRow.id)
      .execute();
    const kept = await trx
      .selectFrom('cloud_save_versions')
      .select(['id'])
      .where('slot_id', '=', slotRow.id)
      .where('committed_at', 'is not', null)
      .orderBy('version', 'desc')
      .limit(options.versionsPerSlot)
      .execute();
    const stale = await trx
      .selectFrom('cloud_save_versions')
      .select(['id', 'object_key'])
      .where('slot_id', '=', slotRow.id)
      .where('committed_at', 'is not', null)
      .where(
        'id',
        'not in',
        kept.map((row) => row.id),
      )
      .execute();
    if (stale.length > 0) {
      await trx
        .deleteFrom('cloud_save_versions')
        .where(
          'id',
          'in',
          stale.map((row) => row.id),
        )
        .execute();
    }
    const version: CloudSaveVersionRecord = {
      id: versionRow.id,
      slot_id: versionRow.slot_id,
      version: versionRow.version,
      size_bytes: bigint(versionRow.size_bytes),
      object_key: versionRow.object_key,
      content_type: versionRow.content_type,
      committed_at: options.now,
      created_at: versionRow.created_at,
    };
    const slot: CloudSaveSlotRecord = {
      ...slotRecord(slotRow),
      current_version_id: version.id,
      size_bytes: version.size_bytes,
      updated_at: options.now,
    };
    const data: CloudSaveCommittedData = {
      slot_id: slot.id,
      user_id: slot.user_id,
      game_id: slot.game_id,
      slot: slot.slot,
      version: version.version,
      version_id: version.id,
      size_bytes: version.size_bytes,
      committed_at: options.now.toISOString(),
    };
    await writeEvent<Database, CloudSaveCommittedData>(
      trx,
      cloudSaveCommittedEvent(data, options.actor),
    );
    await writeAudit(trx, options.actor, 'games.cloud_save.committed', slot.id);
    return {
      status: 'ok' as const,
      slot,
      version,
      pruned: stale.map((row) => row.object_key),
    };
  });
}

export async function abandonUpload(
  db: Kysely<Database>,
  options: { versionId: string; slotId: string },
): Promise<string | null> {
  const row = await db
    .selectFrom('cloud_save_versions')
    .select(['object_key'])
    .where('id', '=', options.versionId)
    .where('slot_id', '=', options.slotId)
    .where('committed_at', 'is', null)
    .executeTakeFirst();
  if (!row) return null;
  await db
    .deleteFrom('cloud_save_versions')
    .where('id', '=', options.versionId)
    .where('committed_at', 'is', null)
    .execute();
  return row.object_key;
}

export type DeleteSlotOutcome =
  { status: 'ok'; slot: CloudSaveSlotRecord; prefix: string } | { status: 'not_found' };

export async function deleteSlot(
  db: Kysely<Database>,
  options: {
    userId: string;
    gameId: string;
    slot: string;
    reason: string;
    actor: EventActor;
    now: Date;
  },
): Promise<DeleteSlotOutcome> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('cloud_save_slots')
      .selectAll()
      .where('user_id', '=', options.userId)
      .where('game_id', '=', options.gameId)
      .where('slot', '=', options.slot)
      .executeTakeFirst();
    if (!row) return { status: 'not_found' as const };
    const slot = slotRecord(row);
    await trx.deleteFrom('cloud_save_slots').where('id', '=', slot.id).execute();
    const data: CloudSaveDeletedData = {
      slot_id: slot.id,
      user_id: slot.user_id,
      game_id: slot.game_id,
      slot: slot.slot,
      reason: options.reason,
    };
    await writeEvent<Database, CloudSaveDeletedData>(
      trx,
      cloudSaveDeletedEvent(data, options.actor),
    );
    await writeAudit(trx, options.actor, 'games.cloud_save.deleted', slot.id);
    return {
      status: 'ok' as const,
      slot,
      prefix: cloudSaveSlotPrefix(slot.user_id, slot.game_id, slot.slot),
    };
  });
}

export async function sweepStalePending(
  db: Kysely<Database>,
  store: ObjectStore | null,
  options: { olderThan: Date },
): Promise<{ deleted: number }> {
  const rows = await db
    .selectFrom('cloud_save_versions')
    .select(['id', 'object_key'])
    .where('committed_at', 'is', null)
    .where('created_at', '<', options.olderThan)
    .execute();
  if (rows.length === 0) return { deleted: 0 };
  await db
    .deleteFrom('cloud_save_versions')
    .where(
      'id',
      'in',
      rows.map((row) => row.id),
    )
    .where('committed_at', 'is', null)
    .execute();
  if (store !== null) {
    for (const row of rows) await store.delete(row.object_key);
  }
  return { deleted: rows.length };
}

export async function eraseUserCloudSaves(
  db: Kysely<Database>,
  userId: string,
  store: ObjectStore | null = null,
): Promise<void> {
  const slots = await db
    .selectFrom('cloud_save_slots')
    .select(['id', 'game_id', 'slot'])
    .where('user_id', '=', userId)
    .execute();
  if (slots.length === 0) return;
  await db.deleteFrom('cloud_save_slots').where('user_id', '=', userId).execute();
  if (store !== null) {
    for (const slot of slots) {
      await store.deletePrefix(cloudSaveSlotPrefix(userId, slot.game_id, slot.slot));
    }
  }
}

export async function exportUserCloudSaves(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('cloud_save_slots')
    .innerJoin('games', 'games.id', 'cloud_save_slots.game_id')
    .leftJoin(
      'cloud_save_versions',
      'cloud_save_versions.id',
      'cloud_save_slots.current_version_id',
    )
    .select([
      'cloud_save_slots.id as id',
      'games.slug as game_slug',
      'cloud_save_slots.slot as slot',
      'cloud_save_slots.size_bytes as size_bytes',
      'cloud_save_slots.created_at as created_at',
      'cloud_save_slots.updated_at as updated_at',
      'cloud_save_versions.version as current_version',
      'cloud_save_versions.content_type as content_type',
    ])
    .where('cloud_save_slots.user_id', '=', userId)
    .orderBy('cloud_save_slots.updated_at', 'desc')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    game_slug: row.game_slug,
    slot: row.slot,
    size_bytes: bigint(row.size_bytes),
    current_version: row.current_version ?? null,
    content_type: row.content_type ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}
