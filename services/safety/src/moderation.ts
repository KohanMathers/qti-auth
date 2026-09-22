import { randomUUID } from 'node:crypto';

import { writeEvent } from '@qtiauth/bus';
import type { SafetyActionType, SafetyPriority } from '@qtiauth/config';
import { updatedRows } from '@qtiauth/db';
import type { EventActor } from '@qtiauth/events';
import { type Kysely } from 'kysely';

import { isPermanentBan, type ModerationCatalog, ruleOf } from './catalog.ts';
import {
  type ActionStatus,
  type ActionType,
  type ApprovalStatus,
  type Database,
  type ReportStatus,
} from './database.ts';
import {
  contentRemovalRequestedEvent,
  type ContentRemovalRequestedData,
  reportActionedEvent,
  type ReportActionedData,
  reportDismissedEvent,
  type ReportDismissedData,
} from './events.ts';
import type { ReportRecord } from './reports.ts';

export const PROSCRIBED_REASON_CODE = 'icu_h1';
export const USER_MODERATION_METHOD = 'user_moderation';

export type ApplyActionError =
  | 'not_found'
  | 'csea'
  | 'closed'
  | 'unknown_action'
  | 'disabled'
  | 'unknown_rule'
  | 'self'
  | 'invalid_target'
  | 'unknown_restriction'
  | 'lock_expiry'
  | 'approval_self'
  | 'approval_not_found'
  | 'approval_closed';

export interface ApplyActionInput {
  reportId: string;
  action: SafetyActionType;
  ruleId: string;
  actorId: string;
  restrictions?: string[];
  expiresAt?: Date | null;
  now: Date;
}

export interface AppliedAction {
  id: string;
  report_id: string;
  user_id: string | null;
  action: ActionType;
  status: ActionStatus;
  rule_id: string;
  restrictions: string[];
  expires_at: Date | null;
  reason_code: string | null;
  actor_id: string;
  created_at: Date;
}

export type ApplyActionResult =
  | { status: 'applied'; action: AppliedAction }
  | { status: 'pending_approval'; action: AppliedAction; approvalId: string }
  | { status: ApplyActionError };

function targetOf(report: ReportRecord): ReportActionedData['target'] {
  return {
    type: report.target_type,
    id: report.target_id,
    user_id: report.target_user_id,
  };
}

function closed(report: ReportRecord): boolean {
  return report.status === 'resolved' || report.status === 'dismissed';
}

function reasonCode(action: SafetyActionType): string | null {
  return action === 'proscribed_org_removal' ? PROSCRIBED_REASON_CODE : null;
}

function validateAction(
  catalog: ModerationCatalog,
  report: ReportRecord,
  input: ApplyActionInput,
): ApplyActionError | null {
  if (report.csea) return 'csea';
  if (closed(report)) return 'closed';
  const defined = catalog.actions.get(input.action);
  if (!defined) return 'unknown_action';
  if (!defined.enabled) return 'disabled';
  if (!ruleOf(catalog, input.ruleId)) return 'unknown_rule';
  if (report.target_user_id !== null && report.target_user_id === input.actorId) return 'self';

  if (input.action === 'remove_content') {
    if (report.target_type !== 'content') return 'invalid_target';
    return null;
  }
  if (input.action === 'warn') return null;
  if (report.target_user_id === null) return 'invalid_target';

  if (input.action === 'restrict') {
    const requested = input.restrictions ?? [];
    if (requested.length === 0) return 'unknown_restriction';
    for (const name of requested) {
      if (!catalog.restrictions.includes(name)) return 'unknown_restriction';
    }
  }
  if (input.action === 'lock') {
    if (input.expiresAt === undefined || input.expiresAt === null) return 'lock_expiry';
    if (input.expiresAt.getTime() <= input.now.getTime()) return 'lock_expiry';
  }
  return null;
}

async function insertAction(
  trx: Kysely<Database>,
  report: ReportRecord,
  input: ApplyActionInput,
  status: ActionStatus,
): Promise<AppliedAction> {
  const id = randomUUID();
  const restrictions = input.action === 'restrict' ? (input.restrictions ?? []) : [];
  const expiresAt =
    input.action === 'lock' || input.action === 'restrict' ? (input.expiresAt ?? null) : null;
  await trx
    .insertInto('moderation_actions')
    .values({
      id,
      report_id: report.id,
      user_id: report.target_user_id,
      action: input.action,
      status,
      rule_id: input.ruleId,
      restrictions,
      expires_at: expiresAt,
      reason_code: reasonCode(input.action),
      actor_id: input.actorId,
      created_at: input.now,
    })
    .execute();
  return {
    id,
    report_id: report.id,
    user_id: report.target_user_id,
    action: input.action,
    status,
    rule_id: input.ruleId,
    restrictions,
    expires_at: expiresAt,
    reason_code: reasonCode(input.action),
    actor_id: input.actorId,
    created_at: input.now,
  };
}

async function emitApplied(
  trx: Kysely<Database>,
  report: ReportRecord,
  action: AppliedAction,
  actor: EventActor,
): Promise<void> {
  await writeEvent<Database, ReportActionedData>(
    trx,
    reportActionedEvent(
      report.id,
      {
        report_id: report.id,
        action_id: action.id,
        action: action.action,
        rule_id: action.rule_id,
        target: targetOf(report),
        ...(action.restrictions.length > 0 ? { restrictions: action.restrictions } : {}),
        ...(action.expires_at ? { expires_at: action.expires_at.toISOString() } : {}),
        ...(action.reason_code ? { reason_code: action.reason_code } : {}),
      },
      actor,
    ),
  );
  if (action.action === 'remove_content') {
    await writeEvent<Database, ContentRemovalRequestedData>(
      trx,
      contentRemovalRequestedEvent(
        report.id,
        {
          report_id: report.id,
          action_id: action.id,
          target: {
            type: 'content',
            id: report.target_id,
            user_id: report.target_user_id,
          },
          game_id: report.game_id,
        },
        actor,
      ),
    );
  }
}

async function closeReport(
  trx: Kysely<Database>,
  reportId: string,
  outcome: string,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('reports')
    .set({ status: 'resolved', outcome, outcome_at: now, updated_at: now })
    .where('id', '=', reportId)
    .execute();
}

export async function applyAction(
  db: Kysely<Database>,
  catalog: ModerationCatalog,
  report: ReportRecord,
  input: ApplyActionInput,
): Promise<ApplyActionResult> {
  const invalid = validateAction(catalog, report, input);
  if (invalid) return { status: invalid };
  const actor: EventActor = { type: 'user', id: input.actorId };
  const needsApproval = catalog.requireSecondApproval && isPermanentBan(input.action);

  return db.transaction().execute(async (trx) => {
    const action = await insertAction(
      trx,
      report,
      input,
      needsApproval ? 'pending_approval' : 'applied',
    );
    if (needsApproval) {
      const approvalId = randomUUID();
      await trx
        .insertInto('action_approvals')
        .values({
          id: approvalId,
          report_id: report.id,
          action_id: action.id,
          requested_by: input.actorId,
          approved_by: null,
          status: 'pending',
          created_at: input.now,
          decided_at: null,
        })
        .execute();
      return { status: 'pending_approval' as const, action, approvalId };
    }
    await closeReport(trx, report.id, input.action, input.now);
    await emitApplied(trx, report, action, actor);
    return { status: 'applied' as const, action };
  });
}

export async function confirmApproval(
  db: Kysely<Database>,
  options: { approvalId: string; actorId: string; now: Date },
): Promise<
  | { status: 'applied'; action: AppliedAction }
  | { status: 'approval_not_found' }
  | { status: 'approval_closed' }
  | { status: 'approval_self' }
  | { status: 'closed' }
> {
  const row = await db
    .selectFrom('action_approvals')
    .innerJoin('moderation_actions', 'moderation_actions.id', 'action_approvals.action_id')
    .innerJoin('reports', 'reports.id', 'action_approvals.report_id')
    .selectAll('reports')
    .select([
      'action_approvals.id as approval_id',
      'action_approvals.requested_by as requested_by',
      'action_approvals.status as approval_status',
      'moderation_actions.id as action_row_id',
      'moderation_actions.action as action',
      'moderation_actions.rule_id as rule_id',
      'moderation_actions.restrictions as restrictions',
      'moderation_actions.expires_at as expires_at',
      'moderation_actions.reason_code as reason_code',
      'moderation_actions.user_id as action_user_id',
      'moderation_actions.created_at as action_created_at',
    ])
    .where('action_approvals.id', '=', options.approvalId)
    .executeTakeFirst();
  if (!row) return { status: 'approval_not_found' };
  if (row.approval_status !== 'pending') return { status: 'approval_closed' };
  if (row.requested_by === options.actorId) return { status: 'approval_self' };
  if (closed(row)) return { status: 'closed' };

  const actor: EventActor = { type: 'user', id: options.actorId };
  return db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('action_approvals')
      .set({
        status: 'approved',
        approved_by: options.actorId,
        decided_at: options.now,
      })
      .where('id', '=', options.approvalId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (updatedRows(updated) === 0) return { status: 'approval_closed' as const };
    await trx
      .updateTable('moderation_actions')
      .set({ status: 'applied', updated_at: options.now })
      .where('id', '=', row.action_row_id)
      .execute();
    await closeReport(trx, row.id, row.action, options.now);
    const action: AppliedAction = {
      id: row.action_row_id,
      report_id: row.id,
      user_id: row.action_user_id,
      action: row.action,
      status: 'applied',
      rule_id: row.rule_id,
      restrictions: row.restrictions,
      expires_at: row.expires_at,
      reason_code: row.reason_code,
      actor_id: options.actorId,
      created_at: row.action_created_at,
    };
    await emitApplied(trx, row, action, actor);
    return { status: 'applied' as const, action };
  });
}

export async function dismissReport(
  db: Kysely<Database>,
  report: ReportRecord,
  options: { actorId: string; now: Date },
): Promise<{ status: 'ok' } | { status: 'csea' | 'closed' }> {
  if (report.csea) return { status: 'csea' };
  if (closed(report)) return { status: 'closed' };
  const actor: EventActor = { type: 'user', id: options.actorId };
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('reports')
      .set({
        status: 'dismissed',
        outcome: 'dismissed',
        outcome_at: options.now,
        updated_at: options.now,
      })
      .where('id', '=', report.id)
      .execute();
    await writeEvent<Database, ReportDismissedData>(
      trx,
      reportDismissedEvent(
        report.id,
        {
          report_id: report.id,
          type: report.type,
          priority: report.priority,
          target: targetOf(report),
        },
        actor,
      ),
    );
  });
  return { status: 'ok' };
}

export interface QueueFilters {
  status?: ReportStatus;
  priority?: SafetyPriority;
  type?: string;
  after?: { sla_deadline: string; id: string };
  limit: number;
}

export async function listQueue(
  db: Kysely<Database>,
  filters: QueueFilters,
): Promise<ReportRecord[]> {
  let query = db.selectFrom('reports').selectAll().where('csea', '=', false);
  if (filters.status !== undefined) query = query.where('status', '=', filters.status);
  else query = query.where('status', 'in', ['open', 'triaged']);
  if (filters.priority !== undefined) query = query.where('priority', '=', filters.priority);
  if (filters.type !== undefined) query = query.where('type', '=', filters.type);
  if (filters.after !== undefined) {
    const deadline = new Date(filters.after.sla_deadline);
    const afterId = filters.after.id;
    query = query.where((eb) =>
      eb.or([
        eb('sla_deadline', '>', deadline),
        eb.and([eb('sla_deadline', '=', deadline), eb('id', '>', afterId)]),
      ]),
    );
  }
  return query.orderBy('sla_deadline', 'asc').orderBy('id', 'asc').limit(filters.limit).execute();
}

export async function listActionsForReport(
  db: Kysely<Database>,
  reportId: string,
): Promise<AppliedAction[]> {
  return db
    .selectFrom('moderation_actions')
    .selectAll()
    .where('report_id', '=', reportId)
    .orderBy('created_at', 'asc')
    .execute();
}

export async function listUserHistory(
  db: Kysely<Database>,
  userId: string,
  limit: number,
): Promise<AppliedAction[]> {
  return db
    .selectFrom('moderation_actions')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
}

export async function listModeratorHistory(
  db: Kysely<Database>,
  actorId: string,
  limit: number,
): Promise<AppliedAction[]> {
  return db
    .selectFrom('moderation_actions')
    .selectAll()
    .where('actor_id', '=', actorId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .execute();
}

export async function getAction(
  db: Kysely<Database>,
  id: string,
): Promise<AppliedAction | undefined> {
  return db.selectFrom('moderation_actions').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function liftAction(
  trx: Kysely<Database>,
  actionId: string,
  now: Date,
): Promise<void> {
  await trx
    .updateTable('moderation_actions')
    .set({ status: 'lifted', updated_at: now })
    .where('id', '=', actionId)
    .execute();
}

export interface UserModerationView {
  actions: AppliedAction[];
  appeals: {
    id: string;
    action_id: string;
    status: string;
    created_at: Date;
    resolved_at: Date | null;
  }[];
}

export async function userModeration(
  db: Kysely<Database>,
  userId: string,
): Promise<UserModerationView> {
  const [actions, appeals] = await Promise.all([
    listUserHistory(db, userId, 50),
    db
      .selectFrom('appeals')
      .select(['id', 'action_id', 'status', 'created_at', 'resolved_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute(),
  ]);
  return { actions, appeals };
}

export function durationLabel(action: AppliedAction, now: Date): string {
  if (action.action === 'warn') return 'No restriction';
  if (action.action === 'lock' || (action.action === 'restrict' && action.expires_at)) {
    return action.expires_at && action.expires_at.getTime() > now.getTime()
      ? `Until ${action.expires_at.toISOString()}`
      : 'Until lifted';
  }
  if (
    action.action === 'ban' ||
    action.action === 'proscribed_org_removal' ||
    action.action === 'restrict'
  ) {
    return 'Until lifted';
  }
  return 'Immediate';
}

export type { ApprovalStatus };
