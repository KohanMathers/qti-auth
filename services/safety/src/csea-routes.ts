import { SAFETY_NCA_REFERENCE_MAX } from '@qtiauth/config';
import {
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import { CSEA_CHECKLIST_FIELDS } from './checklist.ts';
import {
  type CseaCaseRecord,
  afterCaseOpened,
  applyProtective,
  closeCase,
  countOpenCases,
  decryptEvidence,
  encryptionKey,
  getCase,
  getCaseByReport,
  liftCaseHold,
  listCases,
  listEvidence,
  openCase,
  recordCaseView,
  recordSubmission,
  updateChecklist,
} from './csea.ts';
import { CSEA_CASE_STATUSES } from './database.ts';
import { safetyMetrics } from './metrics.ts';
import { getReport, getReportSnapshot, type ReportRecord } from './reports.ts';
import type { Context } from './service.ts';
import { objectStoreOf } from './storage.ts';
import { loadTaxonomy } from './taxonomy.ts';

const caseQuery = paginationQuery({ defaultLimit: 20, maxLimit: 100 }).extend({
  status: z.enum(CSEA_CASE_STATUSES).optional(),
});

const casePosition = z.object({ submission_deadline: z.iso.datetime(), id: z.uuid() });

const checklistItemSchema = z.object({
  available: z.boolean(),
  value: z.string(),
});

const caseSchema = z.object({
  id: z.uuid(),
  report_id: z.uuid(),
  status: z.enum(CSEA_CASE_STATUSES),
  nca_priority: z.number().int(),
  nca_reference: z.string().nullable(),
  submitted_at: z.iso.datetime().nullable(),
  submission_deadline: z.iso.datetime(),
  evidence_until: z.iso.datetime().nullable(),
  nca_portal_url: z.string(),
  target: z.object({
    type: z.enum(['user', 'content']),
    id: z.string(),
    user_id: z.uuid().nullable(),
  }),
  checklist: z.record(z.string(), checklistItemSchema),
  created_at: z.iso.datetime(),
});

const caseListSchema = z.object({
  id: z.uuid(),
  report_id: z.uuid(),
  status: z.enum(CSEA_CASE_STATUSES),
  nca_priority: z.number().int(),
  submitted_at: z.iso.datetime().nullable(),
  submission_deadline: z.iso.datetime(),
  overdue: z.boolean(),
  created_at: z.iso.datetime(),
});

const detailSchema = caseSchema.extend({
  evidence: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['snapshot', 'metadata']),
      content_type: z.string(),
      content: z.string(),
      created_at: z.iso.datetime(),
    }),
  ),
});

const checklistBody = z.object({
  checklist: z.record(
    z.enum(CSEA_CHECKLIST_FIELDS),
    z.object({
      available: z.boolean().optional(),
      value: z.string().max(2_000).optional(),
    }),
  ),
});

const submitBody = z.object({
  nca_reference: z.string().trim().min(1).max(SAFETY_NCA_REFERENCE_MAX),
  submitted_at: z.iso.datetime().optional(),
  nca_priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  declaration: z.literal(true),
});

const closeBody = z.object({
  reason: z.string().trim().min(1).max(500),
});

const reclassifyBody = z.object({
  type: z.string().min(1),
  subtype: z.string().min(1),
});

function signedIn(identity: { sub: string | null }): string {
  if (identity.sub === null) throw new ProblemError('IDENTITY_TOKEN_INVALID');
  return identity.sub;
}

function presentedCase(record: CseaCaseRecord, report: ReportRecord, ncaPortalUrl: string) {
  return {
    id: record.id,
    report_id: record.report_id,
    status: record.status,
    nca_priority: record.nca_priority,
    nca_reference: record.nca_reference,
    submitted_at: record.submitted_at?.toISOString() ?? null,
    submission_deadline: record.submission_deadline.toISOString(),
    evidence_until: record.evidence_until?.toISOString() ?? null,
    nca_portal_url: ncaPortalUrl,
    target: {
      type: report.target_type,
      id: report.target_id,
      user_id: record.target_user_id,
    },
    checklist: record.checklist,
    created_at: record.created_at.toISOString(),
  };
}

function ensureCsea(ctx: Context): Buffer {
  if (!ctx.config.features.safety.csea.enabled) throw new ProblemError('SAFETY_CSEA_DISABLED');
  try {
    return encryptionKey(ctx.config.safety.csea.encryption_key);
  } catch {
    throw new ProblemError('SAFETY_CSEA_UNAVAILABLE');
  }
}

export async function openCseaCase(ctx: Context, reportId: string): Promise<void> {
  if (!ctx.config.features.safety.csea.enabled) return;
  const key = ensureCsea(ctx);
  const report = await getReport(ctx.db, reportId);
  if (!report?.csea) return;
  const snapshot = await getReportSnapshot(ctx.db, report.id);
  const opened = await openCase(ctx.db, {
    report,
    ...(snapshot === undefined ? {} : { snapshot }),
    key,
    actor: { type: 'system', id: 'safety' },
    now: new Date(),
    config: ctx.config.safety.csea,
  });
  if (opened.status !== 'ok') return;
  ctx.outbox.wake();
  safetyMetrics(ctx.metrics).cseaCasesOpen(await countOpenCases(ctx.db));
  await afterCaseOpened(ctx, opened.case, objectStoreOf(ctx.config));
}

export function cseaRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/safety/csea/cases',
    operation_id: 'safetyAdminCseaQueue',
    summary: 'CSEA cases',
    description:
      'Open and submitted CSEA cases, oldest NCA submission deadline first. Restricted to safety.csea.access. Case content is never listed here.',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.csea.access'],
    rate_limit: 'global',
    request: { query: caseQuery },
    responses: {
      200: { description: 'CSEA cases', schema: pageSchema(caseListSchema) },
    },
    errors: ['SAFETY_CSEA_DISABLED'],
    handler: async ({ ctx, query }) => {
      ensureCsea(ctx);
      const after = decodeCursor(casePosition, query.cursor);
      const now = new Date();
      const rows = await listCases(ctx.db, {
        limit: query.limit + 1,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(after === undefined ? {} : { after }),
      });
      const page = pageOf(rows, query.limit, (row) => ({
        submission_deadline: row.submission_deadline.toISOString(),
        id: row.id,
      }));
      safetyMetrics(ctx.metrics).cseaCasesOpen(await countOpenCases(ctx.db));
      return {
        status: 200 as const,
        body: {
          items: page.items.map((row) => ({
            id: row.id,
            report_id: row.report_id,
            status: row.status,
            nca_priority: row.nca_priority,
            submitted_at: row.submitted_at?.toISOString() ?? null,
            submission_deadline: row.submission_deadline.toISOString(),
            overdue: row.status === 'open' && row.submission_deadline.getTime() <= now.getTime(),
            created_at: row.created_at.toISOString(),
          })),
          next_cursor: page.next_cursor,
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/safety/csea/cases/:case_id',
    operation_id: 'safetyAdminCseaCase',
    summary: 'CSEA case detail',
    description: 'Every view is audited. Restricted to safety.csea.access.',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.csea.access'],
    rate_limit: 'global',
    request: { params: z.object({ case_id: z.uuid() }) },
    responses: {
      200: { description: 'The case, checklist and decrypted evidence', schema: detailSchema },
    },
    errors: ['SAFETY_CSEA_DISABLED', 'SAFETY_CSEA_CASE_NOT_FOUND', 'SAFETY_CSEA_UNAVAILABLE'],
    handler: async ({ ctx, identity, params }) => {
      const key = ensureCsea(ctx);
      const actorId = signedIn(identity);
      const record = await getCase(ctx.db, params.case_id);
      const report = record === undefined ? undefined : await getReport(ctx.db, record.report_id);
      if (record === undefined || report === undefined) {
        throw new ProblemError('SAFETY_CSEA_CASE_NOT_FOUND');
      }
      await recordCaseView(ctx.db, record.id, { type: 'user', id: actorId });
      ctx.outbox.wake();
      const evidence = decryptEvidence(await listEvidence(ctx.db, record.id), key, record.id);
      return {
        status: 200 as const,
        body: {
          ...presentedCase(record, report, ctx.config.safety.csea.nca_portal_url),
          evidence: evidence.map((item) => ({
            id: item.id,
            kind: item.kind,
            content_type: item.content_type,
            content: item.content,
            created_at: item.created_at.toISOString(),
          })),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/safety/csea/cases/:case_id/checklist',
    operation_id: 'safetyAdminCseaChecklist',
    summary: 'Update the NCA submission checklist',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.csea.access'],
    rate_limit: 'global',
    request: { params: z.object({ case_id: z.uuid() }), body: checklistBody },
    responses: { 200: { description: 'Updated checklist', schema: caseSchema } },
    errors: ['SAFETY_CSEA_DISABLED', 'SAFETY_CSEA_CASE_NOT_FOUND', 'SAFETY_CSEA_CASE_CLOSED'],
    handler: async ({ ctx, params, body }) => {
      ensureCsea(ctx);
      const result = await updateChecklist(ctx.db, {
        caseId: params.case_id,
        patch: body.checklist,
        now: new Date(),
      });
      if (result.status !== 'ok') {
        if (result.status === 'not_found') throw new ProblemError('SAFETY_CSEA_CASE_NOT_FOUND');
        throw new ProblemError('SAFETY_CSEA_CASE_CLOSED');
      }
      const report = await getReport(ctx.db, result.case.report_id);
      if (report === undefined) throw new ProblemError('SAFETY_CSEA_CASE_NOT_FOUND');
      return {
        status: 200 as const,
        body: presentedCase(result.case, report, ctx.config.safety.csea.nca_portal_url),
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/safety/csea/cases/:case_id/submit',
    operation_id: 'safetyAdminCseaSubmit',
    summary: 'Record an NCA CSEA-IRP submission',
    description:
      'Staff submit through the NCA portal, then record the unique reference and submission time.',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.csea.access'],
    rate_limit: 'global',
    request: { params: z.object({ case_id: z.uuid() }), body: submitBody },
    responses: { 200: { description: 'Submission recorded', schema: caseSchema } },
    errors: [
      'SAFETY_CSEA_DISABLED',
      'SAFETY_CSEA_CASE_NOT_FOUND',
      'SAFETY_CSEA_CASE_CLOSED',
      'SAFETY_CSEA_SUBMIT_INVALID',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      ensureCsea(ctx);
      const actorId = signedIn(identity);
      const result = await recordSubmission(ctx.db, {
        caseId: params.case_id,
        ncaReference: body.nca_reference,
        submittedAt: body.submitted_at === undefined ? new Date() : new Date(body.submitted_at),
        ...(body.nca_priority === undefined ? {} : { priority: body.nca_priority }),
        actor: { type: 'user', id: actorId },
        now: new Date(),
        evidenceRetention: ctx.config.retention.csea_evidence,
        referenceRetention: ctx.config.retention.csea_nca_reference,
      });
      if (result.status !== 'ok') {
        if (result.status === 'not_found') throw new ProblemError('SAFETY_CSEA_CASE_NOT_FOUND');
        if (result.status === 'closed') throw new ProblemError('SAFETY_CSEA_CASE_CLOSED');
        throw new ProblemError('SAFETY_CSEA_SUBMIT_INVALID');
      }
      ctx.outbox.wake();
      safetyMetrics(ctx.metrics).cseaCasesOpen(await countOpenCases(ctx.db));
      const report = await getReport(ctx.db, result.case.report_id);
      if (report === undefined) throw new ProblemError('SAFETY_CSEA_CASE_NOT_FOUND');
      return {
        status: 200 as const,
        body: presentedCase(result.case, report, ctx.config.safety.csea.nca_portal_url),
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/safety/csea/cases/:case_id/protect',
    operation_id: 'safetyAdminCseaProtect',
    summary: 'One-click lock and content removal',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.csea.access'],
    rate_limit: 'global',
    request: { params: z.object({ case_id: z.uuid() }) },
    responses: { 204: { description: 'Protective action applied' } },
    errors: [
      'SAFETY_CSEA_DISABLED',
      'SAFETY_CSEA_CASE_NOT_FOUND',
      'SAFETY_CSEA_CASE_CLOSED',
      'SAFETY_TARGET_INVALID',
    ],
    handler: async ({ ctx, identity, params }) => {
      ensureCsea(ctx);
      const actorId = signedIn(identity);
      const record = await getCase(ctx.db, params.case_id);
      const report = record === undefined ? undefined : await getReport(ctx.db, record.report_id);
      if (record === undefined || report === undefined) {
        throw new ProblemError('SAFETY_CSEA_CASE_NOT_FOUND');
      }
      const result = await applyProtective(ctx.db, {
        report,
        record,
        actorId,
        now: new Date(),
        lockFor: ctx.config.safety.csea.protective_lock,
      });
      if (result.status === 'closed') throw new ProblemError('SAFETY_CSEA_CASE_CLOSED');
      if (result.status === 'invalid_target') throw new ProblemError('SAFETY_TARGET_INVALID');
      ctx.outbox.wake();
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/safety/csea/cases/:case_id/close',
    operation_id: 'safetyAdminCseaClose',
    summary: 'Close a CSEA case that is not CSEA',
    description:
      'Destroys held evidence, lifts the legal hold, and returns the report to the moderation queue.',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.csea.access'],
    rate_limit: 'global',
    request: { params: z.object({ case_id: z.uuid() }), body: closeBody },
    responses: { 204: { description: 'The case was closed' } },
    errors: ['SAFETY_CSEA_DISABLED', 'SAFETY_CSEA_CASE_NOT_FOUND', 'SAFETY_CSEA_CASE_CLOSED'],
    handler: async ({ ctx, identity, params, body }) => {
      ensureCsea(ctx);
      const actorId = signedIn(identity);
      const record = await getCase(ctx.db, params.case_id);
      if (!record) throw new ProblemError('SAFETY_CSEA_CASE_NOT_FOUND');
      const result = await closeCase(ctx.db, {
        record,
        actor: { type: 'user', id: actorId },
        now: new Date(),
        reason: body.reason,
        store: objectStoreOf(ctx.config),
      });
      if (result.status === 'closed') throw new ProblemError('SAFETY_CSEA_CASE_CLOSED');
      await liftCaseHold(ctx, record);
      ctx.outbox.wake();
      safetyMetrics(ctx.metrics).cseaCasesOpen(await countOpenCases(ctx.db));
      return { status: 204 as const };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/safety/reports/:report_id/reclassify',
    operation_id: 'safetyAdminReclassify',
    summary: 'Reclassify a report, opening a CSEA case when the new type is flagged',
    tags: ['safety', 'admin'],
    auth: 'session',
    permissions: ['safety.actions.apply'],
    rate_limit: 'global',
    request: { params: z.object({ report_id: z.uuid() }), body: reclassifyBody },
    responses: { 204: { description: 'The report was reclassified' } },
    errors: [
      'SAFETY_MODERATION_DISABLED',
      'SAFETY_REPORT_NOT_FOUND',
      'SAFETY_REPORT_CLOSED',
      'SAFETY_TAXONOMY_UNKNOWN',
      'SAFETY_CSEA_ALREADY_OPEN',
    ],
    handler: async ({ ctx, identity, params, body }) => {
      if (!ctx.config.features.safety.moderation.enabled) {
        throw new ProblemError('SAFETY_MODERATION_DISABLED');
      }
      signedIn(identity);
      const report = await getReport(ctx.db, params.report_id);
      if (!report) throw new ProblemError('SAFETY_REPORT_NOT_FOUND');
      if (report.status === 'resolved' || report.status === 'dismissed') {
        throw new ProblemError('SAFETY_REPORT_CLOSED');
      }
      const type = loadTaxonomy(ctx.config.safety).resolve(body.type, body.subtype);
      if (!type) throw new ProblemError('SAFETY_TAXONOMY_UNKNOWN');
      if (type.csea && (await getCaseByReport(ctx.db, report.id))) {
        throw new ProblemError('SAFETY_CSEA_ALREADY_OPEN');
      }
      await ctx.db
        .updateTable('reports')
        .set({
          type: type.id,
          subtype: body.subtype,
          csea: type.csea,
          priority: type.default_priority,
          sla_deadline: new Date(Date.now() + type.sla_ms),
          updated_at: new Date(),
        })
        .where('id', '=', report.id)
        .execute();
      if (type.csea) await openCseaCase(ctx, report.id);
      return { status: 204 as const };
    },
  });
}
