import type { Bus } from '@qtiauth/bus';
import { SAFETY_NOTE_MAX, SAFETY_PRIORITIES, SAFETY_SNAPSHOT_MAX } from '@qtiauth/config';
import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { REPORT_STATUSES } from './database.ts';
import {
  type CreatedReport,
  type CreateReportInput,
  type CreateReportResult,
  createReport,
  getReport,
  getReporterStatus,
  queueReporterAck,
} from './reports.ts';
import type { Context } from './service.ts';
import { loadTaxonomy } from './taxonomy.ts';

const targetSchema = z.object({
  type: z.enum(['user', 'content']),
  id: z.string().min(1).max(200),
  user_id: z.uuid().nullable().default(null),
});

const snapshotSchema = z.object({
  content_type: z.string().min(1).max(80),
  content: z.string().min(1).max(SAFETY_SNAPSHOT_MAX),
  captured_at: z.iso.datetime().optional(),
});

const contextSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
  .refine((value) => JSON.stringify(value).length <= 4_096, {
    message: 'context is too large',
  })
  .optional();

const reportBody = z.object({
  type: z.string().min(1),
  subtype: z.string().min(1),
  target: targetSchema,
  note: z.string().max(SAFETY_NOTE_MAX).nullable().default(null),
  snapshot: snapshotSchema.optional(),
  context: contextSchema,
});

const intakeBody = reportBody.extend({
  game_id: z.string().min(1).max(80).nullable().default(null),
  priority: z.enum(SAFETY_PRIORITIES).optional(),
});

const flagBody = z.object({
  type: z.string().min(1),
  subtype: z.string().min(1),
  target: targetSchema,
  classifier: z.string().min(1).max(80),
  score: z.number(),
  priority: z.enum(SAFETY_PRIORITIES).optional(),
  note: z.string().max(SAFETY_NOTE_MAX).nullable().default(null),
  snapshot: snapshotSchema.optional(),
  context: contextSchema,
  game_id: z.string().min(1).max(80).nullable().default(null),
});

const receiptSchema = z.object({
  id: z.uuid(),
  status: z.enum(REPORT_STATUSES),
  type: z.string(),
  subtype: z.string(),
  priority: z.enum(SAFETY_PRIORITIES),
  csea: z.boolean(),
  sla_deadline: z.iso.datetime(),
  created_at: z.iso.datetime(),
});

const statusSchema = z.object({
  id: z.uuid(),
  status: z.enum(REPORT_STATUSES),
  outcome: z.string().nullable(),
  created_at: z.iso.datetime(),
});

const detailSchema = receiptSchema.extend({
  target: targetSchema,
  source: z.enum(['user', 'game', 'service', 'automated']),
  outcome: z.string().nullable(),
  outcome_at: z.iso.datetime().nullable(),
  sla_breach_notified_at: z.iso.datetime().nullable(),
  classifier: z.string().nullable(),
  classifier_score: z.number().nullable(),
});

const taxonomyResponseSchema = z.object({
  types: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      default_priority: z.enum(SAFETY_PRIORITIES),
      subtypes: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});

function presented(report: CreatedReport) {
  return {
    id: report.id,
    status: report.status,
    type: report.type,
    subtype: report.subtype,
    priority: report.priority,
    csea: report.csea,
    sla_deadline: report.sla_deadline.toISOString(),
    created_at: report.created_at.toISOString(),
  };
}

function reportError(
  result: Extract<CreateReportResult, { status: 'unknown_taxonomy' | 'invalid_target' }>,
): never {
  if (result.status === 'unknown_taxonomy') throw new ProblemError('SAFETY_TAXONOMY_UNKNOWN');
  throw new ProblemError('SAFETY_TARGET_INVALID');
}

function signedIn(identity: { sub: string | null }): string {
  if (identity.sub === null) throw new ProblemError('IDENTITY_TOKEN_INVALID');
  return identity.sub;
}

function ensureIntakeEnabled(enabled: boolean): void {
  if (!enabled) throw new ProblemError('SAFETY_INTAKE_DISABLED');
}

function checkGame(callerGameId: string | null, requestedGameId: string | null): void {
  if (callerGameId === null || requestedGameId === null) return;
  if (callerGameId !== requestedGameId) throw new ProblemError('SAFETY_GAME_MISMATCH');
}

function callerGameId(identity: { client_id: string | null }): string | null {
  return identity.client_id?.startsWith('game:') === true
    ? identity.client_id.slice('game:'.length)
    : null;
}

async function submitAndAck(
  ctx: Context,
  bus: Bus,
  input: CreateReportInput,
): Promise<CreatedReport> {
  const taxonomy = loadTaxonomy(ctx.config.safety);
  const result = await createReport(ctx.db, taxonomy, input);
  if (result.status !== 'ok') reportError(result);
  ctx.outbox.wake();
  const brand = ctx.config.branding;
  await queueReporterAck(ctx.db, bus, result.report, input, {
    reporterAckEnabled: ctx.config.safety.reports.reporter_ack,
    productName: brand.product_name,
    supportEmail: brand.support_email,
    hashKey: ctx.config.observability.logs.user_id_hash_key,
    defaultLocale: ctx.config.email.default_locale,
  });
  return result.report;
}

export function intakeRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/safety/taxonomy',
    operation_id: 'safetyTaxonomy',
    summary: 'Report taxonomy',
    description: 'Types and subtypes offered to reporters. Priorities and SLAs stay server-side.',
    tags: ['safety'],
    auth: 'none',
    rate_limit: 'global',
    responses: {
      200: { description: 'Taxonomy', schema: taxonomyResponseSchema },
    },
    handler: ({ ctx }) => {
      const taxonomy = loadTaxonomy(ctx.config.safety);
      return Promise.resolve({
        status: 200 as const,
        body: {
          types: taxonomy.list().map((type) => ({
            id: type.id,
            name: type.name,
            default_priority: type.default_priority,
            subtypes: type.subtypes.map((subtype) => ({ id: subtype.id, name: subtype.name })),
          })),
        },
      });
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/safety/reports',
    operation_id: 'safetyReport',
    summary: 'Report a user or content',
    description:
      'Reporters are never identified to the reported user. CSEA-flagged reports open a case instead of a moderation ticket.',
    tags: ['safety'],
    auth: 'session',
    rate_limit: 'safety_report',
    request: { body: reportBody },
    responses: {
      201: { description: 'The report was accepted', schema: receiptSchema },
    },
    errors: ['SAFETY_TAXONOMY_UNKNOWN', 'SAFETY_TARGET_INVALID'],
    handler: async ({ ctx, identity, body }) => {
      ensureIntakeEnabled(ctx.config.features.safety.reports.enabled);
      const userId = signedIn(identity);
      const report = await submitAndAck(ctx, ctx.bus, {
        typeId: body.type,
        subtypeId: body.subtype,
        target: body.target,
        source: 'user',
        reporter: { userId, contact: null, locale: null },
        note: body.note,
        context: body.context ?? null,
        ...(body.snapshot === undefined
          ? {}
          : {
              snapshot: {
                content_type: body.snapshot.content_type,
                content: body.snapshot.content,
                ...(body.snapshot.captured_at === undefined
                  ? {}
                  : { captured_at: new Date(body.snapshot.captured_at) }),
              },
            }),
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      return { status: 201 as const, body: presented(report) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/safety/reports/:report_id',
    operation_id: 'safetyReportStatus',
    summary: 'Check a report you filed',
    description: 'Only the reporter can look up their own report by id.',
    tags: ['safety'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: z.object({ report_id: z.uuid() }) },
    responses: { 200: { description: 'Report status', schema: statusSchema } },
    errors: ['SAFETY_REPORT_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      const userId = signedIn(identity);
      const view = await getReporterStatus(ctx.db, params.report_id, userId);
      if (!view) throw new ProblemError('SAFETY_REPORT_NOT_FOUND');
      return {
        status: 200 as const,
        body: {
          id: view.id,
          status: view.status,
          outcome: view.outcome,
          created_at: view.created_at.toISOString(),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/safety/intake/reports',
    operation_id: 'safetyIntakeReport',
    summary: 'Submit a report from a game or service',
    description:
      'Callers authenticate with a service token or an OAuth access token holding safety.reports.submit. Reporters are never identified to the reported user.',
    tags: ['safety', 'intake'],
    auth: 'service',
    scopes: ['safety.reports.submit'],
    rate_limit: 'safety_intake',
    request: { body: intakeBody },
    responses: {
      201: { description: 'The report was accepted', schema: receiptSchema },
    },
    errors: ['SAFETY_TAXONOMY_UNKNOWN', 'SAFETY_TARGET_INVALID', 'SAFETY_GAME_MISMATCH'],
    handler: async ({ ctx, identity, body }) => {
      ensureIntakeEnabled(ctx.config.features.safety.game_intake.enabled);
      const caller = callerGameId(identity);
      checkGame(caller, body.game_id);
      const gameId = body.game_id ?? caller;
      const report = await submitAndAck(ctx, ctx.bus, {
        typeId: body.type,
        subtypeId: body.subtype,
        target: body.target,
        source: gameId === null ? 'service' : 'game',
        note: body.note,
        context: body.context ?? null,
        gameId,
        clientId: identity.client_id,
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        ...(body.snapshot === undefined
          ? {}
          : {
              snapshot: {
                content_type: body.snapshot.content_type,
                content: body.snapshot.content,
                ...(body.snapshot.captured_at === undefined
                  ? {}
                  : { captured_at: new Date(body.snapshot.captured_at) }),
              },
            }),
        actor: identity.client_id
          ? { type: 'service', id: identity.client_id }
          : { type: 'system', id: 'safety' },
        now: new Date(),
      });
      return { status: 201 as const, body: presented(report) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/safety/intake/flags',
    operation_id: 'safetyIntakeFlag',
    summary: 'Submit an automated flag',
    description:
      'Machine-generated flags enter the moderation queue with the classifier name and score.',
    tags: ['safety', 'intake'],
    auth: 'service',
    scopes: ['safety.reports.submit'],
    rate_limit: 'safety_intake',
    request: { body: flagBody },
    responses: {
      201: { description: 'The flag was accepted', schema: receiptSchema },
    },
    errors: ['SAFETY_TAXONOMY_UNKNOWN', 'SAFETY_TARGET_INVALID', 'SAFETY_GAME_MISMATCH'],
    handler: async ({ ctx, identity, body }) => {
      ensureIntakeEnabled(ctx.config.features.safety.automated_flags.enabled);
      const caller = callerGameId(identity);
      checkGame(caller, body.game_id);
      const gameId = body.game_id ?? caller;
      const report = await submitAndAck(ctx, ctx.bus, {
        typeId: body.type,
        subtypeId: body.subtype,
        target: body.target,
        source: 'automated',
        note: body.note,
        context: body.context ?? null,
        gameId,
        clientId: identity.client_id,
        classifier: { name: body.classifier, score: body.score },
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        ...(body.snapshot === undefined
          ? {}
          : {
              snapshot: {
                content_type: body.snapshot.content_type,
                content: body.snapshot.content,
                ...(body.snapshot.captured_at === undefined
                  ? {}
                  : { captured_at: new Date(body.snapshot.captured_at) }),
              },
            }),
        actor: identity.client_id
          ? { type: 'service', id: identity.client_id }
          : { type: 'system', id: 'safety' },
        now: new Date(),
      });
      return { status: 201 as const, body: presented(report) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/safety/reports/:report_id',
    operation_id: 'safetyAdminReport',
    summary: 'Report detail for moderators',
    description: 'CSEA reports are not returned here; use the CSEA workflow (safety.csea.access).',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.reports.read'],
    rate_limit: 'global',
    request: { params: z.object({ report_id: z.uuid() }) },
    responses: { 200: { description: 'The report', schema: detailSchema } },
    errors: ['SAFETY_REPORT_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const report = await getReport(ctx.db, params.report_id);
      if (!report || report.csea) throw new ProblemError('SAFETY_REPORT_NOT_FOUND');
      return {
        status: 200 as const,
        body: {
          id: report.id,
          status: report.status,
          type: report.type,
          subtype: report.subtype,
          priority: report.priority,
          csea: report.csea,
          target: {
            type: report.target_type,
            id: report.target_id,
            user_id: report.target_user_id,
          },
          source: report.source,
          outcome: report.outcome,
          outcome_at: report.outcome_at?.toISOString() ?? null,
          sla_deadline: report.sla_deadline.toISOString(),
          sla_breach_notified_at: report.sla_breach_notified_at?.toISOString() ?? null,
          classifier: report.classifier,
          classifier_score: report.classifier_score,
          created_at: report.created_at.toISOString(),
        },
      };
    },
  });
}
