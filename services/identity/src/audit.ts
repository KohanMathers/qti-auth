import { createHash } from 'node:crypto';

import { deletedRows } from '@qtiauth/db';
import type { EventActor, EventEnvelope } from '@qtiauth/events';
import { type Kysely, sql } from 'kysely';

import type { AuditRecordedData } from './events.ts';
import type { Database } from './database.ts';

export const AUDIT_GENESIS_HASH = '0'.repeat(64);
export const AUDIT_CONSUMER = 'audit_store';

export interface AuditRecord {
  seq: number;
  event_id: string;
  occurred_at: Date;
  actor_type: EventActor['type'];
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  prev_hash: string;
  row_hash: string;
}

export type AuditVerifyResult =
  { ok: true; count: number } | { ok: false; seq: number; event_id: string };

export interface AuditListOptions {
  actor_id?: string;
  actor_type?: EventActor['type'];
  action?: string;
  target_type?: string;
  target_id?: string;
  from?: Date;
  to?: Date;
  after?: number;
  limit: number;
}

function seqOf(value: string | number | bigint): number {
  return Number(value);
}

function stamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function auditRowHash(input: {
  seq: number;
  event_id: string;
  occurred_at: Date | string;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  prev_hash: string;
}): string {
  return createHash('sha256')
    .update(
      [
        String(input.seq),
        input.event_id,
        stamp(input.occurred_at),
        input.actor_type,
        input.actor_id,
        input.action,
        input.target_type,
        input.target_id,
        input.prev_hash,
      ].join('\n'),
    )
    .digest('hex');
}

export function verifyAuditRows(rows: readonly AuditRecord[]): AuditVerifyResult {
  for (const [index, row] of rows.entries()) {
    const expected = auditRowHash(row);
    if (expected !== row.row_hash) {
      return { ok: false, seq: row.seq, event_id: row.event_id };
    }
    const previous = rows[index - 1];
    if (previous !== undefined && row.prev_hash !== previous.row_hash) {
      return { ok: false, seq: row.seq, event_id: row.event_id };
    }
  }
  return { ok: true, count: rows.length };
}

function recordedData(event: EventEnvelope): AuditRecordedData {
  const data = event.data as unknown as AuditRecordedData;
  return {
    action: data.action,
    target_type: data.target_type,
    target_id: data.target_id,
  };
}

export async function insertAuditRecord(
  db: Kysely<Database>,
  event: EventEnvelope,
): Promise<boolean> {
  await sql`select pg_advisory_xact_lock(hashtext('qtiauth.audit_log'))`.execute(db);
  const existing = await db
    .selectFrom('audit_log')
    .select('seq')
    .where('event_id', '=', event.event_id)
    .executeTakeFirst();
  if (existing) return false;

  const last = await db
    .selectFrom('audit_log')
    .select(['seq', 'row_hash'])
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  const seq = last === undefined ? 1 : seqOf(last.seq) + 1;
  const prev_hash = last?.row_hash ?? AUDIT_GENESIS_HASH;
  const data = recordedData(event);
  const row_hash = auditRowHash({
    seq,
    event_id: event.event_id,
    occurred_at: event.occurred_at,
    actor_type: event.actor.type,
    actor_id: event.actor.id,
    action: data.action,
    target_type: data.target_type,
    target_id: data.target_id,
    prev_hash,
  });
  await db
    .insertInto('audit_log')
    .values({
      seq,
      event_id: event.event_id,
      occurred_at: new Date(event.occurred_at),
      actor_type: event.actor.type,
      actor_id: event.actor.id,
      action: data.action,
      target_type: data.target_type,
      target_id: data.target_id,
      prev_hash,
      row_hash,
    })
    .execute();
  return true;
}

export async function listAuditRecords(
  db: Kysely<Database>,
  options: AuditListOptions,
): Promise<AuditRecord[]> {
  let query = db.selectFrom('audit_log').selectAll();
  if (options.actor_id !== undefined) query = query.where('actor_id', '=', options.actor_id);
  if (options.actor_type !== undefined) query = query.where('actor_type', '=', options.actor_type);
  if (options.action !== undefined) query = query.where('action', '=', options.action);
  if (options.target_type !== undefined) {
    query = query.where('target_type', '=', options.target_type);
  }
  if (options.target_id !== undefined) query = query.where('target_id', '=', options.target_id);
  if (options.from !== undefined) query = query.where('occurred_at', '>=', options.from);
  if (options.to !== undefined) query = query.where('occurred_at', '<=', options.to);
  if (options.after !== undefined) query = query.where('seq', '<', options.after);
  const rows = await query.orderBy('seq', 'desc').limit(options.limit).execute();
  return rows.map((row) => ({
    ...row,
    seq: seqOf(row.seq),
    actor_type: row.actor_type as EventActor['type'],
  }));
}

export async function loadAuditChain(db: Kysely<Database>): Promise<AuditRecord[]> {
  const rows = await db.selectFrom('audit_log').selectAll().orderBy('seq', 'asc').execute();
  return rows.map((row) => ({
    ...row,
    seq: seqOf(row.seq),
    actor_type: row.actor_type as EventActor['type'],
  }));
}

export async function verifyAuditLog(db: Kysely<Database>): Promise<AuditVerifyResult> {
  return verifyAuditRows(await loadAuditChain(db));
}

export async function sweepAuditLog(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.retention);
  const result = await db.deleteFrom('audit_log').where('occurred_at', '<', cutoff).execute();
  return deletedRows(result);
}

export async function exportAuditRecords(
  db: Kysely<Database>,
  userId: string,
): Promise<
  {
    occurred_at: Date;
    actor_type: string;
    actor_id: string;
    action: string;
    target_type: string;
    target_id: string;
  }[]
> {
  return db
    .selectFrom('audit_log')
    .select(['occurred_at', 'actor_type', 'actor_id', 'action', 'target_type', 'target_id'])
    .where((eb) => eb.or([eb('actor_id', '=', userId), eb('target_id', '=', userId)]))
    .orderBy('seq', 'asc')
    .execute();
}
