import { createHash, randomUUID } from 'node:crypto';

import { type Bus, writeEvent } from '@qtiauth/bus';
import type { SafetyPriority } from '@qtiauth/config';
import { queueEmail } from '@qtiauth/email';
import type { EventActor } from '@qtiauth/events';
import { type Kysely, sql } from 'kysely';

import {
  type Database,
  type ReportSource,
  type ReportStatus,
  type ReportTargetType,
} from './database.ts';
import {
  flagCreatedEvent,
  reportAcknowledgedEvent,
  reportCreatedEvent,
  type ReportSourceData,
} from './events.ts';
import { higherPriority, type Taxonomy } from './taxonomy.ts';

export interface ReportTargetInput {
  type: ReportTargetType;
  id: string;
  user_id?: string | null;
}

export interface ReportSnapshotInput {
  content_type: string;
  content: string;
  captured_at?: Date;
}

export interface CreateReportInput {
  typeId: string;
  subtypeId: string;
  target: ReportTargetInput;
  source: ReportSource;
  reporter?: {
    userId?: string | null;
    contact?: string | null;
    locale?: string | null;
  };
  gameId?: string | null;
  clientId?: string | null;
  priority?: SafetyPriority;
  note?: string | null;
  context?: Record<string, unknown> | null;
  classifier?: { name: string; score: number } | null;
  snapshot?: ReportSnapshotInput;
  actor: EventActor;
  now: Date;
}

export interface CreatedReport {
  id: string;
  status: ReportStatus;
  type: string;
  subtype: string;
  priority: SafetyPriority;
  csea: boolean;
  sla_deadline: Date;
  created_at: Date;
}

export type CreateReportResult =
  | { status: 'ok'; report: CreatedReport }
  | { status: 'unknown_taxonomy' }
  | { status: 'invalid_target' };

function targetValid(target: ReportTargetInput): boolean {
  if (target.id.trim() === '') return false;
  if (target.type === 'user' && target.user_id && target.user_id !== target.id) return false;
  return true;
}

function targetUserId(target: ReportTargetInput): string | null {
  if (target.type === 'user') return target.id;
  return target.user_id ?? null;
}

function sourceData(input: CreateReportInput): ReportSourceData {
  const kind: 'user' | 'game' | 'service' = input.source === 'automated' ? 'service' : input.source;
  return {
    kind,
    game_id: input.gameId ?? null,
    client_id: input.clientId ?? null,
  };
}

export async function createReport(
  db: Kysely<Database>,
  taxonomy: Taxonomy,
  input: CreateReportInput,
): Promise<CreateReportResult> {
  const type = taxonomy.resolve(input.typeId, input.subtypeId);
  if (!type) return { status: 'unknown_taxonomy' };
  if (!targetValid(input.target)) return { status: 'invalid_target' };

  const priority = higherPriority(input.priority ?? type.default_priority, type.default_priority);
  const source = sourceData(input);
  const id = randomUUID();
  const slaDeadline = new Date(input.now.getTime() + type.sla_ms);

  const report = await db.transaction().execute(async (trx): Promise<CreatedReport> => {
    await trx
      .insertInto('reports')
      .values({
        id,
        status: 'open',
        type: type.id,
        subtype: input.subtypeId,
        priority,
        csea: type.csea,
        target_type: input.target.type,
        target_id: input.target.id,
        target_user_id: targetUserId(input.target),
        source: input.source,
        reporter_user_id: input.reporter?.userId ?? null,
        reporter_contact: input.reporter?.contact ?? null,
        reporter_locale: input.reporter?.locale ?? null,
        game_id: input.gameId ?? null,
        client_id: input.clientId ?? null,
        classifier: input.classifier?.name ?? null,
        classifier_score: input.classifier?.score ?? null,
        note: input.note ?? null,
        context: input.context ?? null,
        sla_deadline: slaDeadline,
        sla_breach_notified_at: null,
        outcome: null,
        outcome_at: null,
      })
      .execute();
    if (input.snapshot) {
      await trx
        .insertInto('report_snapshots')
        .values({
          report_id: id,
          content_type: input.snapshot.content_type,
          content: input.snapshot.content,
          captured_at: input.snapshot.captured_at ?? input.now,
        })
        .execute();
    }

    if (!type.csea) {
      if (input.classifier) {
        await writeEvent<Database, ReturnType<typeof flagCreatedEvent>['data']>(
          trx,
          flagCreatedEvent(
            id,
            {
              report_id: id,
              type: type.id,
              subtype: input.subtypeId,
              priority,
              target: {
                type: input.target.type,
                id: input.target.id,
                user_id: targetUserId(input.target),
              },
              classifier: input.classifier.name,
              score: input.classifier.score,
              game_id: input.gameId ?? null,
            },
            input.actor,
          ),
        );
      } else {
        await writeEvent<Database, ReturnType<typeof reportCreatedEvent>['data']>(
          trx,
          reportCreatedEvent(
            id,
            {
              report_id: id,
              type: type.id,
              subtype: input.subtypeId,
              priority,
              target: {
                type: input.target.type,
                id: input.target.id,
                user_id: targetUserId(input.target),
              },
              source,
              sla_deadline: slaDeadline.toISOString(),
            },
            input.actor,
          ),
        );
      }
    }

    return {
      id,
      status: 'open',
      type: type.id,
      subtype: input.subtypeId,
      priority,
      csea: type.csea,
      sla_deadline: slaDeadline,
      created_at: input.now,
    };
  });

  return { status: 'ok', report };
}

export interface AckOptions {
  reporterAckEnabled: boolean;
  productName: string;
  supportEmail: string;
  hashKey: string;
  defaultLocale: string;
}

export async function queueReporterAck(
  db: Kysely<Database>,
  bus: Bus,
  report: CreatedReport,
  input: CreateReportInput,
  options: AckOptions,
): Promise<boolean> {
  if (!options.reporterAckEnabled) return false;
  const contact = input.reporter?.contact;
  if (!contact) return false;
  await queueEmail(bus, {
    template: 'safety_report_received',
    to: { address: contact },
    locale: input.reporter?.locale ?? options.defaultLocale,
    userId: input.reporter?.userId ?? null,
    variables: {
      reference: report.id,
      type: report.type,
      product_name: options.productName,
      support_email: options.supportEmail,
    },
  });
  const recipientHash = createHash('sha256')
    .update(`${options.hashKey}:${contact.toLowerCase()}`)
    .digest('hex');
  await db.transaction().execute(async (trx) => {
    await writeEvent<Database, { report_id: string; recipient_hash: string | null }>(
      trx,
      reportAcknowledgedEvent(report.id, { report_id: report.id, recipient_hash: recipientHash }),
    );
  });
  return true;
}

export interface ReportRecord {
  id: string;
  status: ReportStatus;
  type: string;
  subtype: string;
  priority: SafetyPriority;
  csea: boolean;
  target_type: ReportTargetType;
  target_id: string;
  target_user_id: string | null;
  source: ReportSource;
  reporter_user_id: string | null;
  reporter_contact: string | null;
  reporter_locale: string | null;
  game_id: string | null;
  client_id: string | null;
  classifier: string | null;
  classifier_score: number | null;
  note: string | null;
  context: Record<string, unknown> | null;
  sla_deadline: Date;
  sla_breach_notified_at: Date | null;
  outcome: string | null;
  outcome_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function getReport(
  db: Kysely<Database>,
  id: string,
): Promise<ReportRecord | undefined> {
  const row = await db.selectFrom('reports').selectAll().where('id', '=', id).executeTakeFirst();
  return row;
}

export interface ReporterStatusView {
  id: string;
  status: ReportStatus;
  outcome: string | null;
  created_at: Date;
}

export async function getReporterStatus(
  db: Kysely<Database>,
  id: string,
  reporterUserId: string,
): Promise<ReporterStatusView | undefined> {
  const row = await db
    .selectFrom('reports')
    .select(['id', 'status', 'outcome', 'created_at'])
    .where('id', '=', id)
    .where('reporter_user_id', '=', reporterUserId)
    .executeTakeFirst();
  return row;
}

export async function sweepClosedReports(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.retention);
  const result = await db
    .deleteFrom('reports')
    .where('status', 'in', ['resolved', 'dismissed'])
    .where('outcome_at', '<', cutoff)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

export async function exportUserReports(
  db: Kysely<Database>,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .selectFrom('reports')
    .select([
      'id',
      'status',
      'type',
      'subtype',
      'priority',
      'target_type',
      'target_id',
      'note',
      'created_at',
      'outcome',
      'outcome_at',
    ])
    .where('reporter_user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map((row) => ({
    ...row,
    created_at: row.created_at.toISOString(),
    outcome_at: row.outcome_at?.toISOString() ?? null,
  }));
}

export async function eraseUserReports(trx: Kysely<Database>, userId: string): Promise<void> {
  await sql`
    update reports
    set reporter_user_id = null,
        reporter_contact = null,
        reporter_locale = null
    where reporter_user_id = ${userId}
  `.execute(trx);
  await sql`
    update reports
    set target_user_id = null
    where target_user_id = ${userId}
  `.execute(trx);
}
