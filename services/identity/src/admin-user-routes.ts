import {
  ACCOUNT_STATES,
  AGE_BANDS,
  decodeCursor,
  pageOf,
  pageSchema,
  paginationQuery,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import {
  ACTION_REASON_MAX,
  type AdminUserError,
  banUser,
  forceReauth,
  forceUsernameReset,
  getUserDetail,
  lockUser,
  revokeUserSessions,
  searchUsers,
  unbanUser,
  unlockUser,
} from './admin-users.ts';
import { NO_STORE } from './headers.ts';
import { identityMetrics } from './metrics.ts';
import type { Context } from './service.ts';
import { signedIn } from './session-routes.ts';

const reasonBody = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(ACTION_REASON_MAX)
    .describe('Why this action is being taken. Recorded in the audit trail.'),
});

const lockBody = reasonBody.extend({
  expires_at: z.iso.datetime().describe('When the lock ends.'),
});

const userIdParam = z.object({ user_id: z.uuid() });
const position = z.object({ created_at: z.iso.datetime(), id: z.uuid() });

const searchQuery = paginationQuery({ defaultLimit: 20, maxLimit: 100 }).extend({
  q: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Full-text search on username and email.'),
  state: z.enum(ACCOUNT_STATES).optional().describe('Only accounts in this state.'),
  age_band: z.enum(AGE_BANDS).optional().describe('Only accounts in this age band.'),
  role_id: z.uuid().optional().describe('Only accounts assigned this role.'),
  created_from: z.iso
    .datetime()
    .optional()
    .describe('Only accounts created at or after this time.'),
  created_to: z.iso.datetime().optional().describe('Only accounts created at or before this time.'),
});

const roleSchema = z.object({ id: z.uuid(), slug: z.string(), name: z.string() });

const searchItemSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  username: z.string().nullable(),
  state: z.enum(ACCOUNT_STATES),
  age_band: z.enum(AGE_BANDS),
  created_at: z.iso.datetime(),
  roles: z.array(roleSchema),
});

const userDetailSchema = z.object({
  profile: z.object({
    id: z.uuid(),
    email: z.string(),
    email_verified_at: z.iso.datetime().nullable(),
    username: z.string().nullable(),
    username_updated_at: z.iso.datetime().nullable(),
    username_reset_required: z.boolean(),
    state: z.enum(ACCOUNT_STATES),
    age_band: z.enum(AGE_BANDS),
    date_of_birth: z.iso.date(),
    locale: z.string().nullable(),
    public_profile: z.boolean(),
    leaderboard_visible: z.boolean(),
    locked_until: z.iso.datetime().nullable(),
    created_at: z.iso.datetime(),
    roles: z.array(roleSchema),
  }),
  sign_in_methods: z.array(
    z.object({
      id: z.uuid(),
      type: z.string(),
      subject: z.string().nullable(),
      created_at: z.iso.datetime(),
      last_used_at: z.iso.datetime().nullable(),
    }),
  ),
  sessions: z.array(
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
  security_events: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      trust_from: z.string().nullable(),
      trust_to: z.string().nullable(),
      country_from: z.string().nullable(),
      country_to: z.string().nullable(),
      created_at: z.iso.datetime(),
    }),
  ),
  username_history: z.array(
    z.object({
      username: z.string(),
      claimed_at: z.iso.datetime(),
      released_at: z.iso.datetime().nullable(),
    }),
  ),
  staff_actions: z.array(
    z.object({
      id: z.uuid(),
      actor_type: z.string(),
      actor_id: z.string(),
      action: z.string(),
      reason: z.string(),
      from_state: z.string().nullable(),
      to_state: z.string().nullable(),
      expires_at: z.iso.datetime().nullable(),
      created_at: z.iso.datetime(),
    }),
  ),
  guardians: z.array(
    z.object({
      email: z.string(),
      status: z.string(),
      email_changes: z.int(),
      requested_at: z.iso.datetime(),
      decided_at: z.iso.datetime().nullable(),
    }),
  ),
  moderation: z.unknown().optional(),
  entitlements: z.unknown().optional(),
  tickets: z.unknown().optional(),
});

function actionError(status: AdminUserError): never {
  switch (status) {
    case 'not_found':
      throw new ProblemError('ACCOUNT_NOT_FOUND');
    case 'self':
      throw new ProblemError('ACCOUNT_SELF');
    case 'conflict':
      throw new ProblemError('ACCOUNT_STATE_CONFLICT');
    case 'lock_expiry':
      throw new ProblemError('LOCK_EXPIRY_INVALID');
  }
}

export function adminUserRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/users',
    operation_id: 'searchUsers',
    summary: 'Search accounts',
    description:
      'Full-text search on username and email, with filters on state, age band, role and created date.',
    tags: ['admin'],
    auth: 'session',
    permissions: ['users.read'],
    rate_limit: 'global',
    request: { query: searchQuery },
    responses: { 200: { description: 'Matching accounts', schema: pageSchema(searchItemSchema) } },
    handler: async ({ ctx, query }) => {
      const after = decodeCursor(position, query.cursor);
      const rows = await searchUsers(ctx.db, {
        limit: query.limit + 1,
        bands: ctx.config.age.bands,
        now: new Date(),
        ...(query.q === undefined ? {} : { q: query.q }),
        ...(query.state === undefined ? {} : { state: query.state }),
        ...(query.age_band === undefined ? {} : { ageBand: query.age_band }),
        ...(query.role_id === undefined ? {} : { roleId: query.role_id }),
        ...(query.created_from === undefined ? {} : { createdFrom: new Date(query.created_from) }),
        ...(query.created_to === undefined ? {} : { createdTo: new Date(query.created_to) }),
        ...(after === undefined ? {} : { after }),
      });
      const page = pageOf(rows, query.limit, (row) => ({
        created_at: row.created_at.toISOString(),
        id: row.id,
      }));
      return {
        status: 200,
        headers: NO_STORE,
        body: {
          next_cursor: page.next_cursor,
          items: page.items.map((row) => ({
            id: row.id,
            email: row.email,
            username: row.username,
            state: row.state,
            age_band: row.age_band,
            created_at: row.created_at.toISOString(),
            roles: row.roles,
          })),
        },
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/users/:user_id',
    operation_id: 'getUser',
    summary: 'Account detail for staff',
    description:
      'Assembles profile, sign-in methods, sessions, security events and username history locally. Optional-service sections (moderation, entitlements, tickets) are omitted when that service is not running.',
    tags: ['admin'],
    auth: 'session',
    permissions: ['users.read'],
    rate_limit: 'global',
    request: { params: userIdParam },
    responses: { 200: { description: 'The account', schema: userDetailSchema } },
    errors: ['ACCOUNT_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const now = new Date();
      const detail = await getUserDetail(ctx.db, {
        userId: params.user_id,
        bus: ctx.bus,
        bands: ctx.config.age.bands,
        idleTimeout: ctx.config.cookies.idle_timeout,
        now,
      });
      if (!detail) throw new ProblemError('ACCOUNT_NOT_FOUND');
      return { status: 200, headers: NO_STORE, body: detail };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/users/:user_id/ban',
    operation_id: 'banUser',
    summary: 'Ban an account',
    tags: ['admin'],
    auth: 'session',
    permissions: ['users.ban'],
    step_up: true,
    rate_limit: 'global',
    request: { params: userIdParam, body: reasonBody },
    responses: { 204: { description: 'The account is banned' } },
    errors: ['ACCOUNT_NOT_FOUND', 'ACCOUNT_SELF', 'ACCOUNT_STATE_CONFLICT'],
    handler: async ({ ctx, identity, params, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await banUser(ctx.db, {
        userId: params.user_id,
        actorId: userId,
        reason: body.reason,
        now: new Date(),
      });
      if (result.status !== 'ok') actionError(result.status);
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).adminUserAction('ban');
      log.info('user banned', { user_id: params.user_id });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/users/:user_id/unban',
    operation_id: 'unbanUser',
    summary: 'Lift a ban',
    tags: ['admin'],
    auth: 'session',
    permissions: ['users.ban'],
    step_up: true,
    rate_limit: 'global',
    request: { params: userIdParam, body: reasonBody },
    responses: { 204: { description: 'The ban was lifted' } },
    errors: ['ACCOUNT_NOT_FOUND', 'ACCOUNT_SELF', 'ACCOUNT_STATE_CONFLICT'],
    handler: async ({ ctx, identity, params, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await unbanUser(ctx.db, {
        userId: params.user_id,
        actorId: userId,
        reason: body.reason,
        now: new Date(),
      });
      if (result.status !== 'ok') actionError(result.status);
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).adminUserAction('unban');
      log.info('user unbanned', { user_id: params.user_id });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/users/:user_id/lock',
    operation_id: 'lockUser',
    summary: 'Lock an account until a given time',
    tags: ['admin'],
    auth: 'session',
    permissions: ['users.lock'],
    step_up: true,
    rate_limit: 'global',
    request: { params: userIdParam, body: lockBody },
    responses: { 204: { description: 'The account is locked' } },
    errors: ['ACCOUNT_NOT_FOUND', 'ACCOUNT_SELF', 'ACCOUNT_STATE_CONFLICT', 'LOCK_EXPIRY_INVALID'],
    handler: async ({ ctx, identity, params, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await lockUser(ctx.db, {
        userId: params.user_id,
        actorId: userId,
        reason: body.reason,
        expiresAt: new Date(body.expires_at),
        now: new Date(),
      });
      if (result.status !== 'ok') actionError(result.status);
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).adminUserAction('lock');
      log.info('user locked', { user_id: params.user_id });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/users/:user_id/unlock',
    operation_id: 'unlockUser',
    summary: 'Unlock an account',
    tags: ['admin'],
    auth: 'session',
    permissions: ['users.lock'],
    step_up: true,
    rate_limit: 'global',
    request: { params: userIdParam, body: reasonBody },
    responses: { 204: { description: 'The lock was lifted' } },
    errors: ['ACCOUNT_NOT_FOUND', 'ACCOUNT_SELF', 'ACCOUNT_STATE_CONFLICT'],
    handler: async ({ ctx, identity, params, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await unlockUser(ctx.db, {
        userId: params.user_id,
        actorId: userId,
        reason: body.reason,
        now: new Date(),
      });
      if (result.status !== 'ok') actionError(result.status);
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).adminUserAction('unlock');
      log.info('user unlocked', { user_id: params.user_id });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/users/:user_id/reauth',
    operation_id: 'forceReauth',
    summary: 'Force every session to re-authenticate',
    description: 'Drops every active session to aal0. The user signs in again on the same session.',
    tags: ['admin'],
    auth: 'session',
    permissions: ['users.lock'],
    step_up: true,
    rate_limit: 'global',
    request: { params: userIdParam, body: reasonBody },
    responses: {
      200: {
        description: 'Sessions that must re-authenticate',
        schema: z.object({ challenged: z.int() }),
      },
    },
    errors: ['ACCOUNT_NOT_FOUND', 'ACCOUNT_SELF'],
    handler: async ({ ctx, identity, params, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await forceReauth(ctx.db, {
        userId: params.user_id,
        actorId: userId,
        reason: body.reason,
        now: new Date(),
      });
      if (result.status !== 'ok') actionError(result.status);
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).adminUserAction('force_reauth');
      log.info('user re-auth forced', { user_id: params.user_id, challenged: result.challenged });
      return { status: 200, headers: NO_STORE, body: { challenged: result.challenged } };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/users/:user_id/sessions/revoke',
    operation_id: 'revokeUserSessions',
    summary: 'Revoke every session for an account',
    tags: ['admin'],
    auth: 'session',
    permissions: ['users.lock'],
    step_up: true,
    rate_limit: 'global',
    request: { params: userIdParam, body: reasonBody },
    responses: {
      200: {
        description: 'How many sessions ended',
        schema: z.object({ revoked: z.int() }),
      },
    },
    errors: ['ACCOUNT_NOT_FOUND', 'ACCOUNT_SELF'],
    handler: async ({ ctx, identity, params, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await revokeUserSessions(ctx.db, {
        userId: params.user_id,
        actorId: userId,
        reason: body.reason,
        now: new Date(),
      });
      if (result.status !== 'ok') actionError(result.status);
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).adminUserAction('revoke_sessions');
      identityMetrics(ctx.metrics).sessionsRevoked('revoked', result.revoked.length);
      log.info('user sessions revoked', {
        user_id: params.user_id,
        revoked: result.revoked.length,
      });
      return {
        status: 200,
        headers: NO_STORE,
        body: { revoked: result.revoked.length },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/users/:user_id/username-reset',
    operation_id: 'forceUsernameReset',
    summary: 'Force the user to choose a new username',
    description: 'Releases the current username. The user picks a new one on next sign-in.',
    tags: ['admin'],
    auth: 'session',
    permissions: ['users.force_username_reset'],
    step_up: true,
    rate_limit: 'global',
    request: { params: userIdParam, body: reasonBody },
    responses: { 204: { description: 'The username was released' } },
    errors: ['ACCOUNT_NOT_FOUND', 'ACCOUNT_SELF'],
    handler: async ({ ctx, identity, params, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await forceUsernameReset(ctx.db, {
        userId: params.user_id,
        actorId: userId,
        reason: body.reason,
        now: new Date(),
      });
      if (result.status !== 'ok') actionError(result.status);
      ctx.outbox.wake();
      identityMetrics(ctx.metrics).adminUserAction('force_username_reset');
      log.info('user username reset forced', { user_id: params.user_id });
      return { status: 204, headers: NO_STORE };
    },
  });
}
