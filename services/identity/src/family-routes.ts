import { FAMILY_TOKEN_HEADER, ProblemError, type Router } from '@qtiauth/service-kit';
import * as z from 'zod';

import { findAccount } from './accounts.ts';
import { isValidDateOfBirth } from './age.ts';
import { parseDevice } from './device.ts';
import {
  acceptGuardianInvite,
  actorManagesChild,
  childActivity,
  createFamilySession,
  decideUsernameChange,
  DEFAULT_PARENTAL_CONTROLS,
  familyEventActor,
  inviteGuardian,
  issueFamilyAccess,
  listFamilyChildren,
  listGuardians,
  loadParentalControls,
  pendingUsernameChange,
  resolveFamilyActor,
  revokeFamilySession,
  revokeGuardian,
  updateChildControls,
  type FamilyActor,
} from './family.ts';
import { applyFilter } from './filter.ts';
import {
  sendFamilyAccessEmail,
  sendFamilyInviteEmail,
  sendGuardianRemovedEmail,
  startDataExport,
} from './flows.ts';
import { decideGuardianRemoval, pendingGuardianRemoval } from './graduation.ts';
import { familyHeaders, familySignedOutHeaders, NO_STORE, revokedHeaders } from './headers.ts';
import { acceptLegalAsGuardian, pendingMaterialVersions } from './legal.ts';
import { requestDeletion } from './lifecycle.ts';
import { identityMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { listSessions, revokeSessions, sessionExpiry } from './sessions.ts';
import { clientIp, parentalSettings } from './settings.ts';

const childParam = z.object({ child_id: z.uuid() });
const tokenBody = z.object({ token: z.string().min(1).max(256) });

const controlsSchema = z.object({
  online_play: z.boolean(),
  in_game_chat: z.boolean(),
  user_generated_content: z.boolean(),
  purchases: z.boolean(),
  daily_playtime_minutes: z.int().min(0).nullable(),
  public_profile: z.boolean(),
  leaderboard_visible: z.boolean(),
});

const childSchema = z.object({
  id: z.uuid(),
  username: z.string().nullable(),
  age_band: z.string(),
  account_state: z.string(),
});

const legalPendingSchema = z.array(
  z.object({
    id: z.string(),
    version: z.string(),
    effective_at: z.iso.datetime(),
    material: z.boolean(),
    summary: z.string(),
  }),
);

async function familyActor(
  ctx: Context,
  request: Request,
  identity: { sid: string | null },
): Promise<FamilyActor> {
  const actor = await resolveFamilyActor(ctx.db, {
    familyToken: request.headers.get(FAMILY_TOKEN_HEADER),
    sessionId: identity.sid,
    idleTimeout: ctx.config.cookies.idle_timeout,
    now: new Date(),
  });
  if (!actor) throw new ProblemError('FAMILY_SESSION_REQUIRED');
  return actor;
}

async function managedChild(ctx: Context, actor: FamilyActor, childId: string) {
  const guardian = await actorManagesChild(ctx.db, actor, childId);
  if (!guardian) throw new ProblemError('FAMILY_CHILD_NOT_FOUND');
  const account = await findAccount(ctx.db, childId);
  if (!account || account.state === 'deleted') throw new ProblemError('FAMILY_CHILD_NOT_FOUND');
  return { guardian, account };
}

function presentControls(
  controls: Awaited<ReturnType<typeof loadParentalControls>>,
  account: { public_profile: boolean; leaderboard_visible: boolean },
) {
  return {
    ...(controls ?? DEFAULT_PARENTAL_CONTROLS),
    public_profile: account.public_profile,
    leaderboard_visible: account.leaderboard_visible,
  };
}

function presentLegal(documents: Awaited<ReturnType<typeof pendingMaterialVersions>>) {
  return documents.map((document) => ({
    id: document.id,
    version: document.version,
    effective_at: document.effective_at.toISOString(),
    material: document.material,
    summary: document.summary,
  }));
}

export function familyRoutes(router: Router<Context>): void {
  router.route({
    method: 'POST',
    path: '/api/v1/auth/family/magic-link',
    operation_id: 'requestFamilyMagicLink',
    summary: 'Email a family dashboard link',
    description:
      'Sends a magic link when this address is a parent or guardian. The response does not say whether a link was sent.',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'magic_link',
    request: { body: z.object({ email: z.email().max(254) }) },
    responses: { 202: { description: 'If this address is a guardian, an email is on its way' } },
    handler: async ({ ctx, body, log }) => {
      const issued = await issueFamilyAccess(ctx.db, {
        email: body.email,
        normalizeEmail: parentalSettings(ctx.config).normalizeEmail,
        ttl: ctx.config.magic_link.ttl,
        now: new Date(),
      });
      if (issued) {
        await sendFamilyAccessEmail(ctx, issued);
        ctx.outbox.wake();
        log.info('family access email sent');
      } else {
        log.info('family access email skipped');
      }
      return { status: 202, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/family/session',
    operation_id: 'openFamilySession',
    summary: 'Open a family dashboard session from a magic link',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: { body: tokenBody },
    responses: {
      200: {
        description: 'The family dashboard session is ready',
        schema: z.object({ expires_at: z.iso.datetime() }),
      },
    },
    errors: ['FAMILY_LINK_INVALID'],
    handler: async ({ ctx, body, log }) => {
      const session = await createFamilySession(ctx.db, {
        token: body.token,
        sessionTtl: ctx.config.cookies.session_ttl,
        now: new Date(),
      });
      if (!session) throw new ProblemError('FAMILY_LINK_INVALID');
      identityMetrics(ctx.metrics).familySession();
      log.info('family session started');
      return {
        status: 200,
        headers: familyHeaders(session),
        body: { expires_at: session.expiresAt.toISOString() },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/family/invite/accept',
    operation_id: 'acceptFamilyInvite',
    summary: 'Accept an invitation to become a parent or guardian',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'auth_verify',
    request: {
      body: tokenBody.extend({
        date_of_birth: z.iso
          .date()
          .refine((value) => isValidDateOfBirth(value, new Date()), 'Must be a real date of birth'),
      }),
    },
    responses: { 204: { description: 'This address is now a parent or guardian' } },
    errors: ['FAMILY_LINK_INVALID', 'GUARDIAN_NOT_ADULT', 'GUARDIAN_LIMIT'],
    handler: async ({ ctx, body, log }) => {
      const result = await acceptGuardianInvite(ctx.db, {
        token: body.token,
        dateOfBirth: body.date_of_birth,
        bands: ctx.config.age.bands,
        maxGuardians: ctx.config.parental.max_guardians,
        now: new Date(),
      });
      if (result.status === 'not_adult') throw new ProblemError('GUARDIAN_NOT_ADULT');
      if (result.status === 'limit') throw new ProblemError('GUARDIAN_LIMIT');
      if (result.status !== 'ok') throw new ProblemError('FAMILY_LINK_INVALID');
      ctx.outbox.wake();
      log.info('family invite accepted', { user_id: result.childUserId });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/auth/family/logout',
    operation_id: 'endFamilySession',
    summary: 'End the family dashboard session',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    responses: { 204: { description: 'The family dashboard session has ended' } },
    handler: async ({ ctx, request }) => {
      const token = request.headers.get(FAMILY_TOKEN_HEADER);
      if (token !== null) await revokeFamilySession(ctx.db, { token, now: new Date() });
      return { status: 204, headers: familySignedOutHeaders() };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/family',
    operation_id: 'listFamilyChildren',
    summary: 'List child accounts this parent or guardian can manage',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    responses: {
      200: {
        description: 'Child accounts',
        schema: z.object({ children: z.array(childSchema) }),
      },
    },
    errors: ['FAMILY_SESSION_REQUIRED'],
    handler: async ({ ctx, request, identity }) => {
      const actor = await familyActor(ctx, request, identity);
      const children = await listFamilyChildren(ctx.db, actor, ctx.config.age.bands, new Date());
      return { status: 200, headers: NO_STORE, body: { children } };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/family/:child_id',
    operation_id: 'getFamilyChild',
    summary: 'A child account this parent or guardian can manage',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam },
    responses: {
      200: {
        description: 'The child account, controls and pending items',
        schema: childSchema.extend({
          email: z.email(),
          controls: controlsSchema,
          pending_username_change: z.object({ id: z.uuid(), username: z.string() }).nullable(),
          pending_removal: z.object({ id: z.uuid(), requested_at: z.iso.datetime() }).nullable(),
          pending_legal: legalPendingSchema,
        }),
      },
    },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const now = new Date();
      const [controls, pendingChange, pendingRemoval, pendingLegal, children] = await Promise.all([
        loadParentalControls(ctx.db, account.id),
        pendingUsernameChange(ctx.db, account.id),
        pendingGuardianRemoval(ctx.db, account.id),
        pendingMaterialVersions(ctx.db, account.id, now),
        listFamilyChildren(ctx.db, actor, ctx.config.age.bands, now),
      ]);
      const summary = children.find((child) => child.id === account.id);
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          id: account.id,
          username: account.username,
          age_band: summary?.age_band ?? 'under_13',
          account_state: account.state,
          email: account.email,
          controls: presentControls(controls, account),
          pending_username_change:
            pendingChange === undefined
              ? null
              : { id: pendingChange.id, username: pendingChange.username },
          pending_removal:
            pendingRemoval === undefined
              ? null
              : { id: pendingRemoval.id, requested_at: pendingRemoval.requested_at.toISOString() },
          pending_legal: presentLegal(pendingLegal),
        },
      };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/family/:child_id/controls',
    operation_id: 'updateFamilyControls',
    summary: 'Change game restrictions and visibility for a child account',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: {
      params: childParam,
      body: controlsSchema.partial(),
    },
    responses: {
      200: { description: 'The updated controls', schema: controlsSchema },
    },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params, body, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      await updateChildControls(ctx.db, {
        childUserId: account.id,
        actor: familyEventActor(actor),
        controls: body,
        now: new Date(),
      });
      ctx.outbox.wake();
      log.info('family controls updated', { user_id: account.id });
      const [controls, latest] = await Promise.all([
        loadParentalControls(ctx.db, account.id),
        findAccount(ctx.db, account.id),
      ]);
      return {
        status: 200,
        headers: NO_STORE,
        body: presentControls(controls, latest ?? account),
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/family/:child_id/sessions',
    operation_id: 'listFamilyChildSessions',
    summary: 'List a child’s sessions',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam },
    responses: {
      200: {
        description: 'Active sessions',
        schema: z.object({
          items: z.array(
            z.object({
              id: z.uuid(),
              auth_method: z.string(),
              user_agent: z.string().nullable(),
              device: z.object({ browser: z.string(), os: z.string() }),
              country: z.string().nullable(),
              created_at: z.iso.datetime(),
              last_active_at: z.iso.datetime(),
              expires_at: z.iso.datetime(),
            }),
          ),
        }),
      },
    },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const idleTimeout = ctx.config.cookies.idle_timeout;
      const rows = await listSessions(ctx.db, {
        userId: account.id,
        idleTimeout,
        now: new Date(),
        after: undefined,
        limit: 100,
      });
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          items: rows.map((row) => ({
            id: row.id,
            auth_method: row.auth_method,
            user_agent: row.user_agent,
            device: parseDevice(row.user_agent),
            country: row.last_country,
            created_at: row.created_at.toISOString(),
            last_active_at: row.last_active_at.toISOString(),
            expires_at: sessionExpiry(row, idleTimeout).toISOString(),
          })),
        },
      };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/family/:child_id/sessions/:session_id',
    operation_id: 'revokeFamilyChildSession',
    summary: 'End one of a child’s sessions',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam.extend({ session_id: z.uuid() }) },
    responses: { 204: { description: 'The session has ended' } },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND', 'SESSION_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const revoked = await ctx.db.transaction().execute((trx) =>
        revokeSessions(trx, {
          userId: account.id,
          reason: 'revoked',
          only: [params.session_id],
          now: new Date(),
        }),
      );
      if (revoked.length === 0) throw new ProblemError('SESSION_NOT_FOUND');
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).sessionsRevoked('revoked', revoked.length);
      log.info('child session revoked', { session_id: params.session_id, user_id: account.id });
      return { status: 204, headers: revokedHeaders(revoked) };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/family/:child_id/sessions/revoke-all',
    operation_id: 'revokeFamilyChildSessions',
    summary: 'End every session on a child account',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam },
    responses: {
      200: {
        description: 'The sessions have ended',
        schema: z.object({ revoked: z.int() }),
      },
    },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const revoked = await ctx.db
        .transaction()
        .execute((trx) =>
          revokeSessions(trx, { userId: account.id, reason: 'revoked', now: new Date() }),
        );
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).sessionsRevoked('revoked', revoked.length);
      log.info('child sessions revoked', { user_id: account.id, revoked: revoked.length });
      return { status: 200, headers: revokedHeaders(revoked), body: { revoked: revoked.length } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/family/:child_id/username-changes/:request_id/approve',
    operation_id: 'approveFamilyUsernameChange',
    summary: 'Approve a child’s username change',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam.extend({ request_id: z.uuid() }) },
    responses: {
      200: {
        description: 'The username is now this account’s',
        schema: z.object({ username: z.string() }),
      },
    },
    errors: [
      'FAMILY_SESSION_REQUIRED',
      'FAMILY_CHILD_NOT_FOUND',
      'USERNAME_CHANGE_NOT_FOUND',
      'USERNAME_UNAVAILABLE',
      'USERNAME_COOLDOWN',
      'USERNAME_CHANGE_LIMIT',
    ],
    handler: async ({ ctx, request, identity, params, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const result = await decideUsernameChange(ctx.db, {
        childUserId: account.id,
        requestId: params.request_id,
        approve: true,
        settings: ctx.config.usernames,
        isBlocked: async (username) =>
          (await applyFilter(ctx, username, 'username')).decision === 'block',
        actor: familyEventActor(actor),
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('USERNAME_CHANGE_NOT_FOUND');
      if (result.status === 'unavailable') throw new ProblemError('USERNAME_UNAVAILABLE');
      if (result.status === 'cooldown') {
        throw new ProblemError('USERNAME_COOLDOWN', {
          extensions: { available_at: result.availableAt.toISOString() },
        });
      }
      if (result.status === 'limit') throw new ProblemError('USERNAME_CHANGE_LIMIT');
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).username('change');
      log.info('child username change approved', { user_id: account.id });
      return { status: 200, headers: NO_STORE, body: { username: result.username ?? '' } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/family/:child_id/username-changes/:request_id/decline',
    operation_id: 'declineFamilyUsernameChange',
    summary: 'Decline a child’s username change',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam.extend({ request_id: z.uuid() }) },
    responses: { 204: { description: 'The username was not changed' } },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND', 'USERNAME_CHANGE_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const result = await decideUsernameChange(ctx.db, {
        childUserId: account.id,
        requestId: params.request_id,
        approve: false,
        settings: ctx.config.usernames,
        isBlocked: () => Promise.resolve(false),
        actor: familyEventActor(actor),
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('USERNAME_CHANGE_NOT_FOUND');
      ctx.outbox.wake();
      log.info('child username change declined', { user_id: account.id });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/family/:child_id/legal',
    operation_id: 'getFamilyChildLegal',
    summary: 'Pending legal documents for a child account',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam },
    responses: {
      200: {
        description: 'Pending material versions',
        schema: z.object({ pending: legalPendingSchema }),
      },
    },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const pending = await pendingMaterialVersions(ctx.db, account.id, new Date());
      return { status: 200, headers: NO_STORE, body: { pending: presentLegal(pending) } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/family/:child_id/legal/accept',
    operation_id: 'acceptFamilyChildLegal',
    summary: 'Accept legal documents on a child’s behalf',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: {
      params: childParam,
      body: z.object({
        documents: z.array(z.object({ id: z.string().min(1), version: z.string().min(1) })).min(1),
      }),
    },
    responses: { 204: { description: 'The documents have been accepted' } },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND', 'LEGAL_DOCUMENT_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params, body, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const result = await acceptLegalAsGuardian(ctx.db, {
        childUserId: account.id,
        documents: body.documents,
        ip: clientIp(request) || null,
        actor: familyEventActor(actor),
        now: new Date(),
      });
      if (result.status !== 'ok') throw new ProblemError('LEGAL_DOCUMENT_NOT_FOUND');
      ctx.outbox.wake();
      log.info('child legal accepted', { user_id: account.id, accepted: result.accepted });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/family/:child_id/export',
    operation_id: 'requestFamilyChildExport',
    summary: 'Request a copy of a child’s data',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam },
    responses: {
      202: {
        description: 'The export is being prepared',
        schema: z.object({ id: z.uuid(), status: z.literal('pending') }),
      },
    },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const result = await startDataExport({ ctx, request, log }, { userId: account.id });
      if (result.status === 'not_found') throw new ProblemError('FAMILY_CHILD_NOT_FOUND');
      return {
        status: 202,
        headers: NO_STORE,
        body: { id: result.id, status: 'pending' as const },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/family/:child_id/deletion',
    operation_id: 'requestFamilyChildDeletion',
    summary: 'Ask for a child account to be deleted',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam },
    responses: { 204: { description: 'Deletion is scheduled' } },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND', 'ACCOUNT_STATE_CONFLICT'],
    handler: async ({ ctx, request, identity, params, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const result = await requestDeletion(ctx.db, {
        userId: account.id,
        actor: familyEventActor(actor),
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('FAMILY_CHILD_NOT_FOUND');
      if (result.status === 'conflict') throw new ProblemError('ACCOUNT_STATE_CONFLICT');
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).deletion('requested');
      identityMetrics(ctx.metrics).sessionsRevoked('revoked', result.revoked.length);
      log.info('child account deletion requested', { user_id: account.id });
      return { status: 204, headers: revokedHeaders(result.revoked) };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/family/:child_id/activity',
    operation_id: 'getFamilyChildActivity',
    summary: 'Activity summary for a child account',
    description:
      'Sign-ins for the last seven days. Games and connected apps are empty until those services land.',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam },
    responses: {
      200: {
        description: 'The activity summary',
        schema: z.object({
          period_start: z.iso.datetime(),
          period_end: z.iso.datetime(),
          sign_ins: z.int(),
          games: z.array(z.never()),
          connected_apps: z.array(z.never()),
        }),
      },
    },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const activity = await childActivity(ctx.db, { childUserId: account.id, now: new Date() });
      return { status: 200, headers: NO_STORE, body: activity };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/family/:child_id/guardians',
    operation_id: 'listFamilyGuardians',
    summary: 'Parents and guardians on a child account',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam },
    responses: {
      200: {
        description: 'Guardians',
        schema: z.object({
          guardians: z.array(
            z.object({
              id: z.uuid(),
              email: z.email(),
              display_name: z.string().nullable(),
              status: z.enum(['pending', 'active']),
              linked: z.boolean(),
            }),
          ),
        }),
      },
    },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params }) => {
      const actor = await familyActor(ctx, request, identity);
      await managedChild(ctx, actor, params.child_id);
      const rows = await listGuardians(ctx.db, params.child_id);
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          guardians: rows.map((row) => ({
            id: row.id,
            email: row.email,
            display_name: row.display_name,
            status: row.status === 'pending' ? ('pending' as const) : ('active' as const),
            linked: row.user_id !== null,
          })),
        },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/family/:child_id/guardians',
    operation_id: 'inviteFamilyGuardian',
    summary: 'Invite another parent or guardian',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'magic_link',
    request: {
      params: childParam,
      body: z.object({
        email: z.email().max(254),
        display_name: z.string().max(64).optional(),
      }),
    },
    responses: { 202: { description: 'An invitation email is on its way' } },
    errors: [
      'FAMILY_SESSION_REQUIRED',
      'FAMILY_CHILD_NOT_FOUND',
      'GUARDIAN_EMAIL_INVALID',
      'GUARDIAN_DISPLAY_NAME_INVALID',
      'GUARDIAN_ALREADY_LINKED',
      'GUARDIAN_LIMIT',
    ],
    handler: async ({ ctx, request, identity, params, body, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account, guardian } = await managedChild(ctx, actor, params.child_id);
      const result = await inviteGuardian(ctx.db, {
        childUserId: account.id,
        childNormalized: parentalSettings(ctx.config).normalizeEmail(account.email),
        email: body.email,
        displayName: body.display_name ?? null,
        invitedBy: guardian.id,
        actor: familyEventActor(actor),
        locale: actor.locale,
        settings: {
          maxGuardians: ctx.config.parental.max_guardians,
          normalizeEmail: parentalSettings(ctx.config).normalizeEmail,
        },
        isBlocked: async (name) =>
          (await applyFilter(ctx, name, 'guardian_display_name')).decision === 'block',
        ttl: ctx.config.magic_link.ttl,
        now: new Date(),
      });
      switch (result.status) {
        case 'invalid':
        case 'same_as_child':
          throw new ProblemError('GUARDIAN_EMAIL_INVALID');
        case 'blocked':
          throw new ProblemError('GUARDIAN_DISPLAY_NAME_INVALID');
        case 'duplicate':
          throw new ProblemError('GUARDIAN_ALREADY_LINKED');
        case 'limit':
          throw new ProblemError('GUARDIAN_LIMIT');
        case 'ok':
          await sendFamilyInviteEmail(ctx, result);
          ctx.outbox.wake();
          log.info('family guardian invited', { user_id: account.id });
          return { status: 202, headers: NO_STORE };
      }
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/family/:child_id/guardians/:guardian_id',
    operation_id: 'revokeFamilyGuardian',
    summary: 'Remove a parent or guardian, except the last active one',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam.extend({ guardian_id: z.uuid() }) },
    responses: { 204: { description: 'The parent or guardian has been removed' } },
    errors: [
      'FAMILY_SESSION_REQUIRED',
      'FAMILY_CHILD_NOT_FOUND',
      'GUARDIAN_NOT_FOUND',
      'GUARDIAN_LAST',
    ],
    handler: async ({ ctx, request, identity, params, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const result = await revokeGuardian(ctx.db, {
        childUserId: account.id,
        guardianId: params.guardian_id,
        actor: familyEventActor(actor),
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GUARDIAN_NOT_FOUND');
      if (result.status === 'last') throw new ProblemError('GUARDIAN_LAST');
      ctx.outbox.wake();
      log.info('family guardian revoked', { user_id: account.id });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/family/:child_id/removal/approve',
    operation_id: 'approveFamilyRemoval',
    summary: 'Approve a young person’s request to remove the parent or guardian link',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam },
    responses: { 204: { description: 'The parent or guardian link has been removed' } },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND', 'GUARDIAN_REMOVAL_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const result = await decideGuardianRemoval(ctx.db, {
        childUserId: account.id,
        approve: true,
        actor: familyEventActor(actor),
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GUARDIAN_REMOVAL_NOT_FOUND');
      await sendGuardianRemovedEmail(ctx, {
        username: account.username,
        locale: account.locale,
        guardians: result.guardians ?? [],
      });
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).graduation('removed');
      log.info('guardian removal approved', { user_id: account.id });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/family/:child_id/removal/decline',
    operation_id: 'declineFamilyRemoval',
    summary: 'Decline a young person’s request to remove the parent or guardian link',
    tags: ['family'],
    auth: 'none',
    rate_limit: 'global',
    request: { params: childParam },
    responses: { 204: { description: 'The parent or guardian link stays in place' } },
    errors: ['FAMILY_SESSION_REQUIRED', 'FAMILY_CHILD_NOT_FOUND', 'GUARDIAN_REMOVAL_NOT_FOUND'],
    handler: async ({ ctx, request, identity, params, log }) => {
      const actor = await familyActor(ctx, request, identity);
      const { account } = await managedChild(ctx, actor, params.child_id);
      const result = await decideGuardianRemoval(ctx.db, {
        childUserId: account.id,
        approve: false,
        actor: familyEventActor(actor),
        now: new Date(),
      });
      if (result.status === 'not_found') throw new ProblemError('GUARDIAN_REMOVAL_NOT_FOUND');
      ctx.outbox.wake();
      log.info('guardian removal declined', { user_id: account.id });
      return { status: 204, headers: NO_STORE };
    },
  });
}
