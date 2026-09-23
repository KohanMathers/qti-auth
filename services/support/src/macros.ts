import { randomUUID } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { EventActor } from '@qtiauth/events';
import type { Kysely } from 'kysely';

import type { Database } from './database.ts';
import { type AuditRecordedData, auditRecordedEvent } from './events.ts';

export interface MacroRecord {
  id: string;
  name: string;
  body: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export type MacroCreateResult = { status: 'ok'; macro: MacroRecord } | { status: 'too_long' };

export type MacroWriteResult =
  { status: 'ok'; macro: MacroRecord } | { status: 'not_found' } | { status: 'too_long' };

async function writeAudit(
  db: Kysely<Database>,
  actor: EventActor,
  action: string,
  macroId: string,
): Promise<void> {
  await writeEvent<Database, AuditRecordedData>(
    db,
    auditRecordedEvent(actor, { action, target_type: 'macro', target_id: macroId }),
  );
}

export async function listMacros(db: Kysely<Database>): Promise<MacroRecord[]> {
  return db.selectFrom('macros').selectAll().orderBy('name', 'asc').orderBy('id', 'asc').execute();
}

export async function getMacro(db: Kysely<Database>, id: string): Promise<MacroRecord | undefined> {
  return db.selectFrom('macros').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function createMacro(
  db: Kysely<Database>,
  options: {
    name: string;
    body: string;
    actorId: string;
    maxName: number;
    maxBody: number;
    now: Date;
  },
): Promise<MacroCreateResult> {
  if (options.name.length > options.maxName || options.body.length > options.maxBody) {
    return { status: 'too_long' };
  }
  const actor: EventActor = { type: 'user', id: options.actorId };
  const macro = await db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('macros')
      .values({
        id: randomUUID(),
        name: options.name.trim(),
        body: options.body,
        created_by: options.actorId,
        created_at: options.now,
        updated_at: options.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(trx, actor, 'support.macro.created', row.id);
    return row;
  });
  return { status: 'ok', macro };
}

export async function updateMacro(
  db: Kysely<Database>,
  options: {
    id: string;
    name?: string;
    body?: string;
    actorId: string;
    maxName: number;
    maxBody: number;
    now: Date;
  },
): Promise<MacroWriteResult> {
  if (
    (options.name !== undefined && options.name.length > options.maxName) ||
    (options.body !== undefined && options.body.length > options.maxBody)
  ) {
    return { status: 'too_long' };
  }
  const existing = await getMacro(db, options.id);
  if (!existing) return { status: 'not_found' };
  const actor: EventActor = { type: 'user', id: options.actorId };
  const macro = await db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable('macros')
      .set({
        ...(options.name !== undefined ? { name: options.name.trim() } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
        updated_at: options.now,
      })
      .where('id', '=', options.id)
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    await writeAudit(trx, actor, 'support.macro.updated', row.id);
    return row;
  });
  if (!macro) return { status: 'not_found' };
  return { status: 'ok', macro };
}

export async function deleteMacro(
  db: Kysely<Database>,
  options: { id: string; actorId: string },
): Promise<MacroWriteResult> {
  const existing = await getMacro(db, options.id);
  if (!existing) return { status: 'not_found' };
  const actor: EventActor = { type: 'user', id: options.actorId };
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('macros').where('id', '=', options.id).execute();
    await writeAudit(trx, actor, 'support.macro.deleted', options.id);
  });
  return { status: 'ok', macro: existing };
}
