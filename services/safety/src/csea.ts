import { randomUUID } from 'node:crypto';

import { rpcRequest, writeEvent } from '@qtiauth/bus';
import type { CseaNcaPriority } from '@qtiauth/config';
import { queueEmail } from '@qtiauth/email';
import { AUDIT_EVENTS, type EventActor } from '@qtiauth/events';
import {
  EncryptionKeyError,
  open,
  parseEncryptionKey,
  seal,
  sealedSecretSchema,
} from '@qtiauth/keys';
import { heldObjectKey, type ObjectStore } from '@qtiauth/service-kit';
import { type Kysely } from 'kysely';

import {
  type CseaChecklist,
  type CseaChecklistPatch,
  declarationComplete,
  mergeChecklist,
  parseChecklist,
  prefillChecklist,
} from './checklist.ts';
import { type CseaCaseStatus, type CseaEvidenceKind, type Database } from './database.ts';
import {
  contentRemovalRequestedEvent,
  type ContentRemovalRequestedData,
  cseaCaseOpenedEvent,
  cseaEnforcedEvent,
  type CseaEnforcedData,
} from './events.ts';
import { cseaCaseUrl } from './origin.ts';
import type { ReportRecord, ReportSnapshotView } from './reports.ts';
import type { Context } from './service.ts';

export const PROTECTIVE_RULE_ID = 'protective';
export const HOLD_REASON = 'Open investigation';
export const IDENTITY_SERVICE = 'identity';
export const PLACE_LEGAL_HOLD_METHOD = 'place_legal_hold';
export const GET_LEGAL_HOLD_METHOD = 'get_legal_hold';
export const LIFT_LEGAL_HOLD_METHOD = 'lift_legal_hold';
export const DESTROYED_SEALED = 'destroyed';

export type OpenCaseError = 'not_csea' | 'exists' | 'unavailable';
export type SubmitCaseError = 'not_found' | 'closed' | 'invalid';
export type CloseCaseError = 'not_found' | 'closed';
export type ProtectCaseError = 'not_found' | 'closed' | 'invalid_target';

export interface CseaCaseRecord {
  id: string;
  report_id: string;
  status: CseaCaseStatus;
  nca_priority: number;
  nca_reference: string | null;
  submitted_at: Date | null;
  submission_deadline: Date;
  evidence_until: Date | null;
  reference_until: Date | null;
  legal_hold_id: string | null;
  target_user_id: string | null;
  checklist: CseaChecklist;
  closed_reason: string | null;
  actor_id: string | null;
  created_at: Date;
  updated_at: Date;
  destroyed_at: Date | null;
}

export interface CseaEvidenceRecord {
  id: string;
  case_id: string;
  kind: CseaEvidenceKind;
  content_type: string;
  sealed: string;
  storage_key: string | null;
  created_at: Date;
  destroyed_at: Date | null;
}

export interface CseaEvidenceView {
  id: string;
  kind: CseaEvidenceKind;
  content_type: string;
  content: string;
  created_at: Date;
}

interface AuditRecordedData {
  action: string;
  target_type: string;
  target_id: string;
}

function auditEvent(actor: EventActor, action: string, caseId: string) {
  return {
    type: AUDIT_EVENTS.recorded,
    actor,
    subject: { type: 'csea_case' as const, id: caseId },
    data: { action, target_type: 'csea_case', target_id: caseId } satisfies AuditRecordedData,
  };
}

export function encryptionKey(value: string): Buffer {
  return parseEncryptionKey(value, 'safety.csea.encryption_key');
}

export function tryEncryptionKey(value: string): Buffer | undefined {
  try {
    return encryptionKey(value);
  } catch (error) {
    if (error instanceof EncryptionKeyError) return undefined;
    throw error;
  }
}

export function deadlineFor(
  config: Context['config']['safety']['csea'],
  priority: CseaNcaPriority,
  now: Date,
): Date {
  const ms =
    priority === 1 ? config.priority_1 : priority === 2 ? config.priority_2 : config.priority_3;
  return new Date(now.getTime() + ms);
}

function presented(
  row: Omit<CseaCaseRecord, 'checklist'> & { checklist: unknown },
): CseaCaseRecord {
  return { ...row, checklist: parseChecklist(row.checklist) };
}

function metadataPayload(report: ReportRecord): string {
  return JSON.stringify({
    target_type: report.target_type,
    target_id: report.target_id,
    target_user_id: report.target_user_id,
    source: report.source,
    type: report.type,
    subtype: report.subtype,
    game_id: report.game_id,
    client_id: report.client_id,
    classifier: report.classifier,
    classifier_score: report.classifier_score,
    created_at: report.created_at.toISOString(),
    sla_deadline: report.sla_deadline.toISOString(),
  });
}

function sealText(plaintext: string, key: Buffer, aad: string): string {
  return JSON.stringify(seal(Buffer.from(plaintext, 'utf8'), key, aad));
}

export function openEvidence(sealed: string, key: Buffer, aad: string): string {
  if (sealed === DESTROYED_SEALED) return '';
  const parsed = sealedSecretSchema.safeParse(JSON.parse(sealed) as unknown);
  if (!parsed.success) {
    throw new EncryptionKeyError('Encrypted evidence is not in the expected format');
  }
  return open(parsed.data, key, aad).toString('utf8');
}

async function insertEvidence(
  trx: Kysely<Database>,
  options: {
    caseId: string;
    kind: CseaEvidenceKind;
    contentType: string;
    plaintext: string;
    key: Buffer;
  },
): Promise<void> {
  const id = randomUUID();
  const sealed = sealText(options.plaintext, options.key, options.caseId);
  await trx
    .insertInto('csea_evidence')
    .values({
      id,
      case_id: options.caseId,
      kind: options.kind,
      content_type: options.contentType,
      sealed,
      storage_key: null,
      created_at: new Date(),
      destroyed_at: null,
    })
    .execute();
}

export async function getCase(
  db: Kysely<Database>,
  id: string,
): Promise<CseaCaseRecord | undefined> {
  const row = await db.selectFrom('csea_cases').selectAll().where('id', '=', id).executeTakeFirst();
  return row === undefined ? undefined : presented(row);
}

export async function getCaseByReport(
  db: Kysely<Database>,
  reportId: string,
): Promise<CseaCaseRecord | undefined> {
  const row = await db
    .selectFrom('csea_cases')
    .selectAll()
    .where('report_id', '=', reportId)
    .executeTakeFirst();
  return row === undefined ? undefined : presented(row);
}

export async function listEvidence(
  db: Kysely<Database>,
  caseId: string,
): Promise<CseaEvidenceRecord[]> {
  return db
    .selectFrom('csea_evidence')
    .selectAll()
    .where('case_id', '=', caseId)
    .orderBy('created_at', 'asc')
    .execute();
}

export function decryptEvidence(
  rows: readonly CseaEvidenceRecord[],
  key: Buffer,
  caseId: string,
): CseaEvidenceView[] {
  return rows
    .filter((row) => row.destroyed_at === null && row.sealed !== DESTROYED_SEALED)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      content_type: row.content_type,
      content: openEvidence(row.sealed, key, caseId),
      created_at: row.created_at,
    }));
}

export interface CaseListFilters {
  status?: CseaCaseStatus;
  after?: { submission_deadline: string; id: string };
  limit: number;
}

export async function listCases(
  db: Kysely<Database>,
  filters: CaseListFilters,
): Promise<CseaCaseRecord[]> {
  let query = db.selectFrom('csea_cases').selectAll();
  if (filters.status !== undefined) query = query.where('status', '=', filters.status);
  else query = query.where('status', 'in', ['open', 'submitted']);
  if (filters.after !== undefined) {
    const deadline = new Date(filters.after.submission_deadline);
    const afterId = filters.after.id;
    query = query.where((eb) =>
      eb.or([
        eb('submission_deadline', '>', deadline),
        eb.and([eb('submission_deadline', '=', deadline), eb('id', '>', afterId)]),
      ]),
    );
  }
  const rows = await query
    .orderBy('submission_deadline', 'asc')
    .orderBy('id', 'asc')
    .limit(filters.limit)
    .execute();
  return rows.map((row) => presented(row));
}

export async function countOpenCases(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('csea_cases')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('status', 'in', ['open', 'submitted'])
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function recordCaseView(
  db: Kysely<Database>,
  caseId: string,
  actor: EventActor,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditEvent(actor, 'csea.case.viewed', caseId),
    );
  });
}

export interface OpenCaseInput {
  report: ReportRecord;
  snapshot?: ReportSnapshotView;
  key: Buffer;
  actor: EventActor;
  now: Date;
  priority?: CseaNcaPriority;
  config: Context['config']['safety']['csea'];
}

export async function openCase(
  db: Kysely<Database>,
  input: OpenCaseInput,
): Promise<{ status: 'ok'; case: CseaCaseRecord } | { status: OpenCaseError }> {
  if (!input.report.csea) return { status: 'not_csea' };
  const existing = await getCaseByReport(db, input.report.id);
  if (existing) return { status: 'exists' };
  const priority = input.priority ?? 2;
  const id = randomUUID();
  const checklist = prefillChecklist({
    source: input.report.source,
    gameId: input.report.game_id,
    capturedAt: input.snapshot?.captured_at ?? null,
    hasSnapshot: input.snapshot !== undefined,
    now: input.now,
  });
  const opened = await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('csea_cases')
      .values({
        id,
        report_id: input.report.id,
        status: 'open',
        nca_priority: priority,
        nca_reference: null,
        submitted_at: null,
        submission_deadline: deadlineFor(input.config, priority, input.now),
        evidence_until: null,
        reference_until: null,
        legal_hold_id: null,
        target_user_id: input.report.target_user_id,
        checklist,
        closed_reason: null,
        actor_id: input.actor.type === 'user' ? input.actor.id : null,
        created_at: input.now,
        destroyed_at: null,
      })
      .execute();
    await insertEvidence(trx, {
      caseId: id,
      kind: 'metadata',
      contentType: 'application/json',
      plaintext: metadataPayload(input.report),
      key: input.key,
    });
    if (input.snapshot !== undefined) {
      await insertEvidence(trx, {
        caseId: id,
        kind: 'snapshot',
        contentType: input.snapshot.content_type,
        plaintext: input.snapshot.content,
        key: input.key,
      });
      await trx.deleteFrom('report_snapshots').where('report_id', '=', input.report.id).execute();
    }
    await writeEvent<Database, { case_id: string }>(trx, cseaCaseOpenedEvent(id, input.actor));
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditEvent(input.actor, 'csea.case.opened', id),
    );
    return presented(
      await trx.selectFrom('csea_cases').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
    );
  });
  return { status: 'ok', case: opened };
}

async function writeHeldCopies(
  db: Kysely<Database>,
  store: ObjectStore | null,
  record: CseaCaseRecord,
): Promise<void> {
  if (store === null || record.target_user_id === null) return;
  const rows = await listEvidence(db, record.id);
  for (const row of rows) {
    if (row.destroyed_at !== null) continue;
    const key = heldObjectKey(record.target_user_id, `csea/${record.id}/${row.id}.json`);
    await store.put(key, new TextEncoder().encode(row.sealed), 'application/json');
    await db
      .updateTable('csea_evidence')
      .set({ storage_key: key })
      .where('id', '=', row.id)
      .execute();
  }
}

export async function placeCaseHold(ctx: Context, record: CseaCaseRecord): Promise<string | null> {
  if (record.target_user_id === null) return null;
  const placed = await rpcRequest<{ hold: { id: string } }>(
    ctx.bus,
    IDENTITY_SERVICE,
    PLACE_LEGAL_HOLD_METHOD,
    {
      user_id: record.target_user_id,
      reason: HOLD_REASON,
      case_id: record.id,
    },
  );
  if (placed.status === 'ok') return placed.data.hold.id;
  if (placed.status === 'error' && placed.code === 'conflict') {
    const existing = await rpcRequest<{ hold: { id: string } | null }>(
      ctx.bus,
      IDENTITY_SERVICE,
      GET_LEGAL_HOLD_METHOD,
      { user_id: record.target_user_id },
    );
    if (existing.status === 'ok' && existing.data.hold !== null) return existing.data.hold.id;
  }
  return null;
}

export async function liftCaseHold(ctx: Context, record: CseaCaseRecord): Promise<void> {
  if (record.target_user_id === null) return;
  await rpcRequest(ctx.bus, IDENTITY_SERVICE, LIFT_LEGAL_HOLD_METHOD, {
    user_id: record.target_user_id,
    ...(record.legal_hold_id === null ? {} : { hold_id: record.legal_hold_id }),
  });
}

export async function queueCaseAlert(ctx: Context, caseId: string): Promise<number> {
  const link = cseaCaseUrl(ctx.config.surfaces, caseId);
  if (link === undefined) return 0;
  const recipients = ctx.config.safety.csea_alert_emails;
  for (const address of recipients) {
    await queueEmail(ctx.bus, {
      template: 'csea_case_opened',
      to: { address },
      locale: ctx.config.email.default_locale,
      userId: null,
      variables: { link },
    });
  }
  return recipients.length;
}

export async function afterCaseOpened(
  ctx: Context,
  record: CseaCaseRecord,
  store: ObjectStore | null,
): Promise<void> {
  const holdId = await placeCaseHold(ctx, record);
  if (holdId !== null) {
    await ctx.db
      .updateTable('csea_cases')
      .set({ legal_hold_id: holdId, updated_at: new Date() })
      .where('id', '=', record.id)
      .execute();
  }
  await writeHeldCopies(ctx.db, store, record);
  await queueCaseAlert(ctx, record.id);
}

export async function updateChecklist(
  db: Kysely<Database>,
  options: {
    caseId: string;
    patch: CseaChecklistPatch;
    now: Date;
  },
): Promise<{ status: 'ok'; case: CseaCaseRecord } | { status: 'not_found' | 'closed' }> {
  const current = await getCase(db, options.caseId);
  if (!current) return { status: 'not_found' };
  if (current.status !== 'open' && current.status !== 'submitted') return { status: 'closed' };
  const checklist = mergeChecklist(current.checklist, options.patch);
  await db
    .updateTable('csea_cases')
    .set({ checklist, updated_at: options.now })
    .where('id', '=', options.caseId)
    .execute();
  return { status: 'ok', case: { ...current, checklist, updated_at: options.now } };
}

export async function recordSubmission(
  db: Kysely<Database>,
  options: {
    caseId: string;
    ncaReference: string;
    submittedAt: Date;
    priority?: CseaNcaPriority;
    actor: EventActor;
    now: Date;
    evidenceRetention: number;
    referenceRetention: number;
  },
): Promise<{ status: 'ok'; case: CseaCaseRecord } | { status: SubmitCaseError }> {
  const current = await getCase(db, options.caseId);
  if (!current) return { status: 'not_found' };
  if (current.status !== 'open' && current.status !== 'submitted') return { status: 'closed' };
  if (options.ncaReference.trim() === '') return { status: 'invalid' };
  const checklist = mergeChecklist(current.checklist, {
    declaration: { available: true, value: 'true' },
  });
  if (!declarationComplete(checklist)) return { status: 'invalid' };
  const priority = options.priority ?? current.nca_priority;
  if (priority !== 1 && priority !== 2 && priority !== 3) return { status: 'invalid' };
  const evidenceUntil = new Date(options.submittedAt.getTime() + options.evidenceRetention);
  const referenceUntil = new Date(options.submittedAt.getTime() + options.referenceRetention);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('csea_cases')
      .set({
        status: 'submitted',
        nca_priority: priority,
        nca_reference: options.ncaReference.trim(),
        submitted_at: options.submittedAt,
        evidence_until: evidenceUntil,
        reference_until: referenceUntil,
        checklist,
        updated_at: options.now,
      })
      .where('id', '=', options.caseId)
      .execute();
    await trx
      .updateTable('reports')
      .set({
        status: 'resolved',
        outcome: 'nca_submitted',
        outcome_at: options.now,
        updated_at: options.now,
      })
      .where('id', '=', current.report_id)
      .execute();
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditEvent(options.actor, 'csea.case.submitted', options.caseId),
    );
  });
  const updated = await getCase(db, options.caseId);
  if (updated === undefined) return { status: 'not_found' };
  return { status: 'ok', case: updated };
}

export async function applyProtective(
  db: Kysely<Database>,
  options: {
    report: ReportRecord;
    record: CseaCaseRecord;
    actorId: string;
    now: Date;
    lockFor: number;
  },
): Promise<{ status: 'ok' } | { status: ProtectCaseError }> {
  if (options.record.status !== 'open' && options.record.status !== 'submitted') {
    return { status: 'closed' };
  }
  const actor: EventActor = { type: 'user', id: options.actorId };
  const userId = options.report.target_user_id;
  const canRemove = options.report.target_type === 'content';
  if (userId === null && !canRemove) return { status: 'invalid_target' };
  await db.transaction().execute(async (trx) => {
    if (userId !== null) {
      const actionId = randomUUID();
      const expiresAt = new Date(options.now.getTime() + options.lockFor);
      await trx
        .insertInto('moderation_actions')
        .values({
          id: actionId,
          report_id: options.report.id,
          user_id: userId,
          action: 'lock',
          status: 'applied',
          rule_id: PROTECTIVE_RULE_ID,
          restrictions: [],
          expires_at: expiresAt,
          reason_code: 'protective',
          actor_id: options.actorId,
          created_at: options.now,
        })
        .execute();
      await writeEvent<Database, CseaEnforcedData>(
        trx,
        cseaEnforcedEvent(
          options.report.id,
          {
            report_id: options.report.id,
            action_id: actionId,
            action: 'lock',
            rule_id: PROTECTIVE_RULE_ID,
            target: {
              type: options.report.target_type,
              id: options.report.target_id,
              user_id: userId,
            },
            expires_at: expiresAt.toISOString(),
          },
          actor,
        ),
      );
    }
    if (canRemove) {
      const actionId = randomUUID();
      await trx
        .insertInto('moderation_actions')
        .values({
          id: actionId,
          report_id: options.report.id,
          user_id: userId,
          action: 'remove_content',
          status: 'applied',
          rule_id: PROTECTIVE_RULE_ID,
          restrictions: [],
          expires_at: null,
          reason_code: 'protective',
          actor_id: options.actorId,
          created_at: options.now,
        })
        .execute();
      await writeEvent<Database, ContentRemovalRequestedData>(
        trx,
        contentRemovalRequestedEvent(
          options.report.id,
          {
            report_id: options.report.id,
            action_id: actionId,
            target: {
              type: 'content',
              id: options.report.target_id,
              user_id: userId,
            },
            game_id: options.report.game_id,
          },
          actor,
        ),
      );
    }
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditEvent(actor, 'csea.case.protected', options.record.id),
    );
  });
  return { status: 'ok' };
}

async function destroyEvidenceRows(
  db: Kysely<Database>,
  record: CseaCaseRecord,
  store: ObjectStore | null,
  now: Date,
): Promise<number> {
  const rows = await listEvidence(db, record.id);
  let destroyed = 0;
  for (const row of rows) {
    if (row.destroyed_at !== null) continue;
    if (store !== null && row.storage_key !== null) await store.delete(row.storage_key);
    await db
      .updateTable('csea_evidence')
      .set({ sealed: DESTROYED_SEALED, destroyed_at: now, storage_key: null })
      .where('id', '=', row.id)
      .execute();
    destroyed += 1;
  }
  return destroyed;
}

export async function closeCase(
  db: Kysely<Database>,
  options: {
    record: CseaCaseRecord;
    actor: EventActor;
    now: Date;
    reason: string;
    store: ObjectStore | null;
  },
): Promise<{ status: 'ok' } | { status: CloseCaseError }> {
  if (options.record.status !== 'open') return { status: 'closed' };
  await destroyEvidenceRows(db, options.record, options.store, options.now);
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('csea_cases')
      .set({
        status: 'closed',
        closed_reason: options.reason,
        destroyed_at: options.now,
        updated_at: options.now,
      })
      .where('id', '=', options.record.id)
      .execute();
    await trx
      .updateTable('reports')
      .set({
        csea: false,
        status: 'open',
        outcome: null,
        outcome_at: null,
        updated_at: options.now,
      })
      .where('id', '=', options.record.report_id)
      .execute();
    await writeEvent<Database, AuditRecordedData>(
      trx,
      auditEvent(options.actor, 'csea.case.closed', options.record.id),
    );
  });
  return { status: 'ok' };
}

export async function sweepCseaRetention(
  db: Kysely<Database>,
  options: { now: Date; store: ObjectStore | null; actor?: EventActor },
): Promise<{ evidence: number; references: number }> {
  const actor = options.actor ?? { type: 'system' as const, id: 'safety' };
  const due = await db
    .selectFrom('csea_cases')
    .selectAll()
    .where('status', '=', 'submitted')
    .where('evidence_until', 'is not', null)
    .where('evidence_until', '<=', options.now)
    .execute();
  let evidence = 0;
  for (const row of due) {
    const record = presented(row);
    evidence += await destroyEvidenceRows(db, record, options.store, options.now);
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('csea_cases')
        .set({ status: 'destroyed', destroyed_at: options.now, updated_at: options.now })
        .where('id', '=', record.id)
        .execute();
      await writeEvent<Database, AuditRecordedData>(
        trx,
        auditEvent(actor, 'csea.evidence.destroyed', record.id),
      );
    });
  }
  const refs = await db
    .updateTable('csea_cases')
    .set({ nca_reference: null, updated_at: options.now })
    .where('nca_reference', 'is not', null)
    .where('reference_until', 'is not', null)
    .where('reference_until', '<=', options.now)
    .executeTakeFirst();
  return { evidence, references: Number(refs.numUpdatedRows) };
}
