import { ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { findAccount, SIGNED_IN_STATES } from './accounts.ts';
import { LEGAL_ACCEPTANCE_METHODS } from './database.ts';
import { acceptLegal } from './flows.ts';
import { NO_STORE } from './headers.ts';
import {
  currentLegalVersions,
  findCurrentLegalVersion,
  findViewableLegalVersion,
  type LegalVersion,
  listLegalAcceptances,
  pendingMaterialVersions,
} from './legal.ts';
import { interpolateLegal, LEGAL_DOCUMENT_ID, LEGAL_VERSION } from './legal-documents.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';

const documentId = z.string().regex(LEGAL_DOCUMENT_ID);
const versionId = z.string().regex(LEGAL_VERSION);

const documentSummarySchema = z.object({
  id: z.string(),
  version: z.string(),
  effective_at: z.iso.datetime(),
  material: z.boolean(),
  summary: z.string(),
});

const documentSchema = documentSummarySchema.extend({
  body: z.string(),
});

const acceptBody = z.object({
  documents: z
    .array(z.object({ id: documentId, version: versionId }))
    .min(1)
    .describe('Document versions the user is accepting.'),
});

function presentedSummary(ctx: Context, document: Omit<LegalVersion, 'body'>) {
  return {
    id: document.id,
    version: document.version,
    effective_at: document.effective_at.toISOString(),
    material: document.material,
    summary: interpolateLegal(document.summary, ctx.config.branding),
  };
}

function presentedDocument(ctx: Context, document: LegalVersion) {
  return {
    ...presentedSummary(ctx, document),
    body: interpolateLegal(document.body, ctx.config.branding),
  };
}

export function legalRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/legal',
    operation_id: 'listLegalDocuments',
    summary: 'Current legal documents',
    description:
      'The currently effective version of each document synced from config/legal. Bodies are omitted; fetch one document for the full text.',
    tags: ['legal'],
    auth: 'none',
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Currently effective documents',
        schema: z.object({ documents: z.array(documentSummarySchema) }),
      },
    },
    handler: async ({ ctx }) => {
      const documents = await currentLegalVersions(ctx.db, new Date());
      return {
        status: 200,
        headers: NO_STORE,
        body: { documents: documents.map((document) => presentedSummary(ctx, document)) },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/legal/:id',
    operation_id: 'getLegalDocument',
    summary: 'The currently effective version of a legal document',
    tags: ['legal'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: z.object({ id: documentId }) },
    responses: { 200: { description: 'The current version', schema: documentSchema } },
    errors: ['LEGAL_DOCUMENT_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const document = await findCurrentLegalVersion(ctx.db, params.id, new Date());
      if (!document) throw new ProblemError('LEGAL_DOCUMENT_NOT_FOUND');
      return { status: 200, headers: NO_STORE, body: presentedDocument(ctx, document) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/legal/:id/:version',
    operation_id: 'getLegalDocumentVersion',
    summary: 'A specific version of a legal document',
    description:
      'Previous versions are public when legal.public_history is true. The current version is always available.',
    tags: ['legal'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: z.object({ id: documentId, version: versionId }) },
    responses: { 200: { description: 'That version', schema: documentSchema } },
    errors: ['LEGAL_DOCUMENT_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const document = await findViewableLegalVersion(ctx.db, {
        id: params.id,
        version: params.version,
        publicHistory: ctx.config.legal.public_history,
        now: new Date(),
      });
      if (!document) throw new ProblemError('LEGAL_DOCUMENT_NOT_FOUND');
      return { status: 200, headers: NO_STORE, body: presentedDocument(ctx, document) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/me/legal',
    operation_id: 'getMyLegal',
    summary: 'Legal documents this account still needs to accept',
    tags: ['legal'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Pending material versions and this account’s acceptances',
        schema: z.object({
          pending: z.array(documentSummarySchema),
          accepted: z.array(
            z.object({
              id: z.string(),
              version: z.string(),
              accepted_at: z.iso.datetime(),
              method: z.enum(LEGAL_ACCEPTANCE_METHODS),
            }),
          ),
        }),
      },
    },
    errors: ['ACCOUNT_NOT_FOUND'],
    handler: async ({ ctx, identity }) => {
      const { userId } = signedIn(identity);
      if (!(await findAccount(ctx.db, userId))) throw new ProblemError('ACCOUNT_NOT_FOUND');
      const now = new Date();
      const [pending, accepted] = await Promise.all([
        pendingMaterialVersions(ctx.db, userId, now),
        listLegalAcceptances(ctx.db, userId),
      ]);
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          pending: pending.map((document) => presentedSummary(ctx, document)),
          accepted: accepted.map((row) => ({
            id: row.document_id,
            version: row.version,
            accepted_at: row.accepted_at.toISOString(),
            method: row.method,
          })),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/me/legal/accept',
    operation_id: 'acceptLegal',
    summary: 'Accept legal document versions',
    tags: ['legal'],
    auth: 'session',
    allow_account_states: SIGNED_IN_STATES,
    allow_pending_legal: true,
    allow_pending_parental_consent: true,
    rate_limit: 'global',
    request: { body: acceptBody },
    responses: {
      200: {
        description: 'Accepted. pending is empty when the gate is lifted.',
        schema: z.object({ pending: z.array(documentSummarySchema) }),
      },
    },
    errors: ['ACCOUNT_NOT_FOUND', 'LEGAL_DOCUMENT_NOT_FOUND'],
    handler: async ({ ctx, identity, body, request, log }) => {
      const { userId } = signedIn(identity);
      if (!(await findAccount(ctx.db, userId))) throw new ProblemError('ACCOUNT_NOT_FOUND');
      const result = await acceptLegal(
        { ctx, request, log },
        { userId, documents: body.documents },
      );
      if (result.status === 'unknown') throw new ProblemError('LEGAL_DOCUMENT_NOT_FOUND');
      const pending = await pendingMaterialVersions(ctx.db, userId, new Date());
      return {
        status: 200,
        headers: NO_STORE,
        body: { pending: pending.map((document) => presentedSummary(ctx, document)) },
      };
    },
  });
}
