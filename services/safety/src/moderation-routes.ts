import { SAFETY_ACTIONS, SAFETY_PRIORITIES } from '@qtiauth/config';
import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import {
  type AppealRecord,
  createAppeal,
  listAppeals,
  listUserAppeals,
  resolveAppeal,
} from './appeals.ts';
import { loadCatalog } from './catalog.ts';
import { APPEAL_STATUSES, REPORT_STATUSES } from './database.ts';
import { safetyMetrics } from './metrics.ts';
import {
  type AppliedAction,
  type ApplyActionError,
  applyAction,
  confirmApproval,
  dismissReport,
  listModeratorHistory,
  listQueue,
  listUserHistory,
} from './moderation.ts';
import { queueAppealOutcome, queueStatementOfReasons } from './notify.ts';
import { getReport, queueReporterOutcome } from './reports.ts';
import type { Context } from './service.ts';

const queueQuery = paginationQuery({ defaultLimit: 20, maxLimit: 100 }).extend({
  status: z.enum(REPORT_STATUSES).optional(),
  priority: z.enum(SAFETY_PRIORITIES).optional(),
  type: z.string().min(1).optional(),
});

const queuePosition = z.object({ sla_deadline: z.iso.datetime(), id: z.uuid() });
const createdPosition = z.object({ created_at: z.iso.datetime(), id: z.uuid() });

const queueItemSchema = z.object({
  id: z.uuid(),
  status: z.enum(REPORT_STATUSES),
  type: z.string(),
  subtype: z.string(),
  priority: z.enum(SAFETY_PRIORITIES),
  target: z.object({
    type: z.enum(['user', 'content']),
    id: z.string(),
    user_id: z.uuid().nullable(),
  }),
  source: z.enum(['user', 'game', 'service', 'automated']),
  sla_deadline: z.iso.datetime(),
  created_at: z.iso.datetime(),
});

const actionSchema = z.object({
  id: z.uuid(),
  report_id: z.uuid(),
  user_id: z.uuid().nullable(),
  action: z.string(),
  status: z.string(),
  rule_id: z.string(),
  restrictions: z.array(z.string()),
  expires_at: z.iso.datetime().nullable(),
  reason_code: z.string().nullable(),
  actor_id: z.uuid(),
  created_at: z.iso.datetime(),
});

const applyBody = z.object({
  action: z.enum(SAFETY_ACTIONS),
  rule_id: z.string().min(1),
  restrictions: z.array(z.string().min(1)).optional(),
  expires_at: z.iso.datetime().optional(),
});

const appealBody = z.object({
  action_id: z.uuid(),
  body: z.string().min(1),
});

const resolveBody = z.object({
  outcome: z.enum(['lifted', 'upheld']),
});

const appealSchema = z.object({
  id: z.uuid(),
  action_id: z.uuid(),
  user_id: z.uuid().nullable(),
  body: z.string(),
  status: z.enum(APPEAL_STATUSES),
  ticket_id: z.string().nullable(),
  created_at: z.iso.datetime(),
  resolved_at: z.iso.datetime().nullable(),
});

const catalogSchema = z.object({
  actions: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean() })),
  rules: z.array(z.object({ id: z.string(), name: z.string(), summary: z.string() })),
  restrictions: z.array(z.string()),
  bans: z.object({ require_second_approval: z.boolean() }),
  accountable_person: z.object({ name: z.string(), role: z.string() }),
});

function presentedAction(action: AppliedAction) {
  return {
    id: action.id,
    report_id: action.report_id,
    user_id: action.user_id,
    action: action.action,
    status: action.status,
    rule_id: action.rule_id,
    restrictions: action.restrictions,
    expires_at: action.expires_at?.toISOString() ?? null,
    reason_code: action.reason_code,
    actor_id: action.actor_id,
    created_at: action.created_at.toISOString(),
  };
}

function presentedAppeal(appeal: AppealRecord) {
  return {
    id: appeal.id,
    action_id: appeal.action_id,
    user_id: appeal.user_id,
    body: appeal.body,
    status: appeal.status,
    ticket_id: appeal.ticket_id,
    created_at: appeal.created_at.toISOString(),
    resolved_at: appeal.resolved_at?.toISOString() ?? null,
  };
}

function signedIn(identity: { sub: string | null }): string {
  if (identity.sub === null) throw new ProblemError('IDENTITY_TOKEN_INVALID');
  return identity.sub;
}

function ensureModeration(enabled: boolean): void {
  if (!enabled) throw new ProblemError('SAFETY_MODERATION_DISABLED');
}

function ensureAppeals(enabled: boolean): void {
  if (!enabled) throw new ProblemError('SAFETY_APPEALS_DISABLED');
}

function applyError(status: ApplyActionError): never {
  switch (status) {
    case 'not_found':
    case 'csea':
      throw new ProblemError('SAFETY_REPORT_NOT_FOUND');
    case 'closed':
      throw new ProblemError('SAFETY_REPORT_CLOSED');
    case 'unknown_action':
    case 'disabled':
      throw new ProblemError('SAFETY_ACTION_UNKNOWN');
    case 'unknown_rule':
      throw new ProblemError('SAFETY_RULE_REQUIRED');
    case 'self':
      throw new ProblemError('SAFETY_ACTION_SELF');
    case 'invalid_target':
      throw new ProblemError('SAFETY_TARGET_INVALID');
    case 'unknown_restriction':
      throw new ProblemError('SAFETY_RESTRICTION_UNKNOWN');
    case 'lock_expiry':
      throw new ProblemError('SAFETY_LOCK_EXPIRY_INVALID');
    case 'approval_self':
      throw new ProblemError('SAFETY_APPROVAL_SELF');
    case 'approval_not_found':
      throw new ProblemError('SAFETY_APPROVAL_NOT_FOUND');
    case 'approval_closed':
      throw new ProblemError('SAFETY_APPROVAL_CLOSED');
  }
}

async function afterApplied(
  ctx: Context,
  action: AppliedAction,
  reportCreatedAt: Date,
): Promise<void> {
  const catalog = loadCatalog(ctx.config.safety);
  ctx.outbox.wake();
  safetyMetrics(ctx.metrics).action(action.action);
  safetyMetrics(ctx.metrics).reportClosed('actioned');
  safetyMetrics(ctx.metrics).timeToAction(
    Math.max(0, (action.created_at.getTime() - reportCreatedAt.getTime()) / 1000),
  );
  const report = await getReport(ctx.db, action.report_id);
  if (report) {
    await queueReporterOutcome(ctx.bus, report, action.action, {
      reporterOutcomeEnabled: ctx.config.safety.reports.reporter_outcome,
      productName: ctx.config.branding.product_name,
      supportEmail: ctx.config.branding.support_email,
      defaultLocale: ctx.config.email.default_locale,
    });
  }
  await queueStatementOfReasons(ctx, catalog, action);
}

export function moderationRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/safety/catalog',
    operation_id: 'safetyAdminCatalog',
    summary: 'Moderation actions, rules, restrictions and the accountable person',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.reports.read'],
    rate_limit: 'global',
    responses: { 200: { description: 'The catalog', schema: catalogSchema } },
    handler: ({ ctx }) => {
      const catalog = loadCatalog(ctx.config.safety);
      return Promise.resolve({
        status: 200 as const,
        body: {
          actions: [...catalog.actions.values()],
          rules: [...catalog.rules.values()],
          restrictions: [...catalog.restrictions],
          bans: { require_second_approval: catalog.requireSecondApproval },
          accountable_person: ctx.config.safety.accountable_person,
        },
      });
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/safety/reports',
    operation_id: 'safetyAdminQueue',
    summary: 'Moderation queue',
    description: 'Open reports, oldest SLA deadline first. CSEA reports are omitted.',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.reports.read'],
    rate_limit: 'global',
    request: { query: queueQuery },
    responses: {
      200: { description: 'Reports in the queue', schema: pageSchema(queueItemSchema) },
    },
    handler: async ({ ctx, query }) => {
      const after = decodeCursor(queuePosition, query.cursor);
      const rows = await listQueue(ctx.db, {
        limit: query.limit + 1,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.priority === undefined ? {} : { priority: query.priority }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(after === undefined ? {} : { after }),
      });
      const page = pageOf(rows, query.limit, (row) => ({
        sla_deadline: row.sla_deadline.toISOString(),
        id: row.id,
      }));
      return {
        status: 200 as const,
        body: {
          items: page.items.map((row) => ({
            id: row.id,
            status: row.status,
            type: row.type,
            subtype: row.subtype,
            priority: row.priority,
            target: { type: row.target_type, id: row.target_id, user_id: row.target_user_id },
            source: row.source,
            sla_deadline: row.sla_deadline.toISOString(),
            created_at: row.created_at.toISOString(),
          })),
          next_cursor: page.next_cursor,
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/safety/reports/:report_id/actions',
    operation_id: 'safetyAdminApplyAction',
    summary: 'Apply a moderation action',
    description:
      'Staff must choose a configured rule. Permanent bans can require a second moderator when safety.bans.require_second_approval is on.',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.actions.apply'],
    rate_limit: 'global',
    request: { params: z.object({ report_id: z.uuid() }), body: applyBody },
    responses: {
      201: { description: 'The action was applied', schema: actionSchema },
      202: {
        description: 'Waiting for a second moderator',
        schema: actionSchema.extend({ approval_id: z.uuid() }),
      },
    },
    errors: [
      'SAFETY_MODERATION_DISABLED',
      'SAFETY_REPORT_NOT_FOUND',
      'SAFETY_REPORT_CLOSED',
      'SAFETY_ACTION_UNKNOWN',
      'SAFETY_RULE_REQUIRED',
      'SAFETY_ACTION_SELF',
      'SAFETY_TARGET_INVALID',
      'SAFETY_RESTRICTION_UNKNOWN',
      'SAFETY_LOCK_EXPIRY_INVALID',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      ensureModeration(ctx.config.features.safety.moderation.enabled);
      const actorId = signedIn(identity);
      const report = await getReport(ctx.db, params.report_id);
      if (!report || report.csea) throw new ProblemError('SAFETY_REPORT_NOT_FOUND');
      const result = await applyAction(ctx.db, loadCatalog(ctx.config.safety), report, {
        reportId: report.id,
        action: body.action,
        ruleId: body.rule_id,
        actorId,
        ...(body.restrictions === undefined ? {} : { restrictions: body.restrictions }),
        ...(body.expires_at === undefined ? {} : { expiresAt: new Date(body.expires_at) }),
        now: new Date(),
      });
      if (result.status === 'pending_approval') {
        ctx.outbox.wake();
        return {
          status: 202 as const,
          body: { ...presentedAction(result.action), approval_id: result.approvalId },
        };
      }
      if (result.status !== 'applied') applyError(result.status);
      await afterApplied(ctx, result.action, report.created_at);
      return { status: 201 as const, body: presentedAction(result.action) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/safety/reports/:report_id/dismiss',
    operation_id: 'safetyAdminDismiss',
    summary: 'Dismiss a report',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.actions.apply'],
    rate_limit: 'global',
    request: { params: z.object({ report_id: z.uuid() }) },
    responses: { 204: { description: 'The report was dismissed' } },
    errors: ['SAFETY_MODERATION_DISABLED', 'SAFETY_REPORT_NOT_FOUND', 'SAFETY_REPORT_CLOSED'],
    handler: async ({ ctx, identity, params }) => {
      ensureModeration(ctx.config.features.safety.moderation.enabled);
      const actorId = signedIn(identity);
      const report = await getReport(ctx.db, params.report_id);
      if (!report || report.csea) throw new ProblemError('SAFETY_REPORT_NOT_FOUND');
      const result = await dismissReport(ctx.db, report, { actorId, now: new Date() });
      if (result.status === 'csea') throw new ProblemError('SAFETY_REPORT_NOT_FOUND');
      if (result.status === 'closed') throw new ProblemError('SAFETY_REPORT_CLOSED');
      ctx.outbox.wake();
      safetyMetrics(ctx.metrics).reportClosed('dismissed');
      safetyMetrics(ctx.metrics).timeToAction(
        Math.max(0, (Date.now() - report.created_at.getTime()) / 1000),
      );
      await queueReporterOutcome(ctx.bus, report, 'dismissed', {
        reporterOutcomeEnabled: ctx.config.safety.reports.reporter_outcome,
        productName: ctx.config.branding.product_name,
        supportEmail: ctx.config.branding.support_email,
        defaultLocale: ctx.config.email.default_locale,
      });
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/safety/approvals/:approval_id/confirm',
    operation_id: 'safetyAdminConfirmBan',
    summary: 'Second-moderator confirmation of a permanent ban',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.actions.apply'],
    rate_limit: 'global',
    request: { params: z.object({ approval_id: z.uuid() }) },
    responses: { 201: { description: 'The ban was applied', schema: actionSchema } },
    errors: [
      'SAFETY_MODERATION_DISABLED',
      'SAFETY_APPROVAL_NOT_FOUND',
      'SAFETY_APPROVAL_SELF',
      'SAFETY_APPROVAL_CLOSED',
      'SAFETY_REPORT_CLOSED',
    ],
    handler: async ({ ctx, identity, params }) => {
      ensureModeration(ctx.config.features.safety.moderation.enabled);
      const result = await confirmApproval(ctx.db, {
        approvalId: params.approval_id,
        actorId: signedIn(identity),
        now: new Date(),
      });
      if (result.status !== 'applied') applyError(result.status);
      const report = await getReport(ctx.db, result.action.report_id);
      await afterApplied(ctx, result.action, report?.created_at ?? result.action.created_at);
      return { status: 201 as const, body: presentedAction(result.action) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/safety/users/:user_id/history',
    operation_id: 'safetyAdminUserHistory',
    summary: 'Moderation history for a user',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.reports.read'],
    rate_limit: 'global',
    request: { params: z.object({ user_id: z.uuid() }) },
    responses: {
      200: {
        description: 'Actions against this account',
        schema: z.object({ items: z.array(actionSchema) }),
      },
    },
    handler: async ({ ctx, params }) => {
      const items = await listUserHistory(ctx.db, params.user_id, 100);
      return { status: 200 as const, body: { items: items.map(presentedAction) } };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/safety/moderators/:moderator_id/history',
    operation_id: 'safetyAdminModeratorHistory',
    summary: 'Actions taken by a moderator',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.reports.read'],
    rate_limit: 'global',
    request: { params: z.object({ moderator_id: z.uuid() }) },
    responses: {
      200: {
        description: 'Actions this moderator applied',
        schema: z.object({ items: z.array(actionSchema) }),
      },
    },
    handler: async ({ ctx, params }) => {
      const items = await listModeratorHistory(ctx.db, params.moderator_id, 100);
      return { status: 200 as const, body: { items: items.map(presentedAction) } };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/safety/appeals',
    operation_id: 'safetyAdminAppeals',
    summary: 'Appeals',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.reports.read'],
    rate_limit: 'global',
    request: {
      query: paginationQuery({ defaultLimit: 20, maxLimit: 100 }).extend({
        status: z.enum(APPEAL_STATUSES).optional(),
      }),
    },
    responses: { 200: { description: 'Appeals', schema: pageSchema(appealSchema) } },
    handler: async ({ ctx, query }) => {
      const after = decodeCursor(createdPosition, query.cursor);
      const rows = await listAppeals(ctx.db, {
        limit: query.limit + 1,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(after === undefined ? {} : { after }),
      });
      const page = pageOf(rows, query.limit, (row) => ({
        created_at: row.created_at.toISOString(),
        id: row.id,
      }));
      return {
        status: 200 as const,
        body: {
          items: page.items.map(presentedAppeal),
          next_cursor: page.next_cursor,
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/safety/appeals/:appeal_id/resolve',
    operation_id: 'safetyAdminResolveAppeal',
    summary: 'Lift an action or leave it in place',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.actions.apply'],
    rate_limit: 'global',
    request: { params: z.object({ appeal_id: z.uuid() }), body: resolveBody },
    responses: { 200: { description: 'The appeal was resolved', schema: appealSchema } },
    errors: ['SAFETY_MODERATION_DISABLED', 'SAFETY_APPEAL_NOT_FOUND', 'SAFETY_APPEAL_CLOSED'],
    handler: async ({ ctx, identity, params, body }) => {
      ensureModeration(ctx.config.features.safety.moderation.enabled);
      const result = await resolveAppeal(ctx.db, {
        appealId: params.appeal_id,
        actorId: signedIn(identity),
        outcome: body.outcome,
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('SAFETY_APPEAL_NOT_FOUND');
      if (result.status === 'closed') throw new ProblemError('SAFETY_APPEAL_CLOSED');
      ctx.outbox.wake();
      safetyMetrics(ctx.metrics).appeal(body.outcome);
      await queueAppealOutcome(ctx, result.action, body.outcome);
      return { status: 200 as const, body: presentedAppeal(result.appeal) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/safety/appeals',
    operation_id: 'safetyAppeal',
    summary: 'Appeal a lock, ban or restriction',
    description:
      'Locked, banned or restricted users can appeal. When Support is running the appeal is also opened as a ticket.',
    tags: ['safety'],
    auth: 'session',
    allow_account_states: ['active', 'banned', 'locked'],
    rate_limit: 'safety_appeal',
    request: { body: appealBody },
    responses: { 201: { description: 'The appeal was accepted', schema: appealSchema } },
    errors: [
      'SAFETY_APPEALS_DISABLED',
      'SAFETY_APPEAL_NOT_FOUND',
      'SAFETY_APPEAL_NOT_ALLOWED',
      'SAFETY_APPEAL_EXISTS',
      'SAFETY_APPEAL_INVALID',
    ],
    handler: async ({ ctx, identity, body }) => {
      ensureAppeals(ctx.config.features.safety.appeals.enabled);
      const userId = signedIn(identity);
      const result = await createAppeal(ctx.db, ctx.bus, {
        actionId: body.action_id,
        userId,
        body: body.body,
        maxLength: ctx.config.safety.appeals.max_length,
        supportTickets: ctx.config.features.support.tickets.enabled,
        now: new Date(),
      });
      if (result.status === 'too_long') throw new ProblemError('SAFETY_APPEAL_INVALID');
      if (result.status === 'not_found') throw new ProblemError('SAFETY_APPEAL_NOT_FOUND');
      if (result.status === 'not_allowed') throw new ProblemError('SAFETY_APPEAL_NOT_ALLOWED');
      if (result.status === 'exists') throw new ProblemError('SAFETY_APPEAL_EXISTS');
      ctx.outbox.wake();
      safetyMetrics(ctx.metrics).appeal('opened');
      return { status: 201 as const, body: presentedAppeal(result.appeal) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/safety/appeals',
    operation_id: 'safetyMyAppeals',
    summary: 'Appeals you filed',
    tags: ['safety'],
    auth: 'session',
    allow_account_states: ['active', 'banned', 'locked'],
    rate_limit: 'global',
    responses: {
      200: { description: 'Your appeals', schema: z.object({ items: z.array(appealSchema) }) },
    },
    handler: async ({ ctx, identity }) => {
      const items = await listUserAppeals(ctx.db, signedIn(identity));
      return { status: 200 as const, body: { items: items.map(presentedAppeal) } };
    },
  });
}
