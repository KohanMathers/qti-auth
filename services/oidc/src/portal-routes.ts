import { rpcRequest } from '@qtiauth/bus';
import {
  OIDC_CLIENT_DESCRIPTION_MAX,
  OIDC_CLIENT_NAME_MAX,
  OIDC_CLIENT_TYPES,
} from '@qtiauth/config';
import {
  CHECK_TEXT_METHOD,
  CHECK_TEXT_SERVICE,
  checkTextResponseSchema,
  ProblemError,
  type Router,
} from '@qtiauth/service-kit';
import * as z from 'zod';

import type { ClientRecord } from './clients.ts';
import { childAccount } from './oauth-core.ts';
import {
  type ClientWriteError,
  createClient,
  deleteClient,
  getOwnedClient,
  listOwnedClients,
  regenerateSecret,
  suspendClient,
  type TextCheckResult,
  unsuspendClient,
  updateClient,
  verifyClient,
} from './portal.ts';
import type { Context } from './service.ts';
import { ADMIN_CLIENTS_PATH, CLIENTS_PATH } from './settings.ts';

const NO_STORE = { 'cache-control': 'no-store' };

const clientIdParam = z.object({ client_id: z.string().min(1).max(64) });

const createBody = z.object({
  name: z.string().trim().min(1).max(OIDC_CLIENT_NAME_MAX),
  description: z.string().trim().max(OIDC_CLIENT_DESCRIPTION_MAX).default(''),
  type: z.enum(OIDC_CLIENT_TYPES),
  redirect_uris: z.array(z.string().min(1).max(2048)).default([]),
  require_par: z.boolean().default(false),
  backchannel_logout_uri: z.string().min(1).max(2048).nullable().default(null),
  backchannel_logout_session_required: z.boolean().default(false),
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(OIDC_CLIENT_NAME_MAX).optional(),
  description: z.string().trim().max(OIDC_CLIENT_DESCRIPTION_MAX).optional(),
  redirect_uris: z.array(z.string().min(1).max(2048)).optional(),
  require_par: z.boolean().optional(),
  backchannel_logout_uri: z.string().min(1).max(2048).nullable().optional(),
  backchannel_logout_session_required: z.boolean().optional(),
});

const clientSchema = z.object({
  client_id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(OIDC_CLIENT_TYPES),
  verified: z.boolean(),
  redirect_uris: z.array(z.string()),
  require_par: z.boolean(),
  backchannel_logout_uri: z.string().nullable(),
  backchannel_logout_session_required: z.boolean(),
  suspended: z.boolean(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const createdSchema = clientSchema.extend({ secret: z.string().nullable() });

function signedIn(identity: { sub: string | null }): string {
  if (identity.sub === null) throw new ProblemError('IDENTITY_TOKEN_INVALID');
  return identity.sub;
}

function presented(client: ClientRecord) {
  return {
    client_id: client.client_id,
    name: client.name,
    description: client.description,
    type: client.type,
    verified: client.verified || client.first_party,
    redirect_uris: client.redirect_uris,
    require_par: client.require_par,
    backchannel_logout_uri: client.backchannel_logout_uri,
    backchannel_logout_session_required: client.backchannel_logout_session_required,
    suspended: client.suspended_at !== null,
    created_at: client.created_at.toISOString(),
    updated_at: client.updated_at.toISOString(),
  };
}

function presentedSecret(client: ClientRecord, secret: string | null) {
  return { ...presented(client), secret };
}

function requirePortal(ctx: Context): void {
  if (!ctx.config.features.oidc.developer_portal.enabled) {
    throw new ProblemError('DEVELOPER_PORTAL_DISABLED');
  }
}

async function checkClientText(
  ctx: Context,
  text: string,
  context: string,
): Promise<TextCheckResult> {
  const result = await rpcRequest(
    ctx.bus,
    CHECK_TEXT_SERVICE,
    CHECK_TEXT_METHOD,
    { text, context },
    { metrics: ctx.busMetrics },
  );
  if (result.status !== 'ok') return 'unavailable';
  const parsed = checkTextResponseSchema.safeParse(result.data);
  if (!parsed.success) return 'unavailable';
  return parsed.data.decision;
}

function writeError(result: ClientWriteError): never {
  switch (result.status) {
    case 'not_found':
      throw new ProblemError('CLIENT_NOT_FOUND');
    case 'limit':
      throw new ProblemError('CLIENT_LIMIT_REACHED');
    case 'name_rejected':
      throw new ProblemError('CLIENT_NAME_REJECTED');
    case 'description_rejected':
      throw new ProblemError('CLIENT_DESCRIPTION_REJECTED');
    case 'invalid_redirect':
      throw new ProblemError('VALIDATION_FAILED', {
        detail: 'Redirect URIs must be unique https URLs, or http on 127.0.0.1 or [::1]',
      });
    case 'invalid_logout_uri':
      throw new ProblemError('VALIDATION_FAILED', {
        detail: 'backchannel_logout_uri must be an https URL, or http on 127.0.0.1 or [::1]',
      });
    case 'unavailable':
      throw new ProblemError('SERVICE_UNAVAILABLE');
    case 'public_no_secret':
      throw new ProblemError('CLIENT_SECRET_NOT_APPLICABLE');
  }
}

const PORTAL_ERRORS = ['DEVELOPER_PORTAL_DISABLED'] as const;
const CREATE_ERRORS = [
  ...PORTAL_ERRORS,
  'CLIENT_CHILD_ACCOUNT',
  'CLIENT_LIMIT_REACHED',
  'CLIENT_NAME_REJECTED',
  'CLIENT_DESCRIPTION_REJECTED',
] as const;
const UPDATE_ERRORS = [
  ...PORTAL_ERRORS,
  'CLIENT_NOT_FOUND',
  'CLIENT_NAME_REJECTED',
  'CLIENT_DESCRIPTION_REJECTED',
] as const;

export function portalRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: CLIENTS_PATH,
    operation_id: 'listOauthClients',
    summary: 'OAuth clients owned by the signed-in user',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'global',
    responses: {
      200: { description: 'Owned clients', schema: z.object({ items: z.array(clientSchema) }) },
    },
    errors: [...PORTAL_ERRORS],
    handler: async ({ ctx, identity }) => {
      requirePortal(ctx);
      const items = await listOwnedClients(ctx.db, signedIn(identity));
      return {
        status: 200,
        headers: NO_STORE,
        body: { items: items.map((client) => presented(client)) },
      };
    },
  });

  router.route({
    method: 'POST',
    path: CLIENTS_PATH,
    operation_id: 'createOauthClient',
    summary: 'Register an OAuth client',
    description:
      'Confidential clients receive a secret once. The client works immediately; unverified apps show a notice on the consent screen.',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'global',
    request: { body: createBody },
    responses: { 201: { description: 'The client was created', schema: createdSchema } },
    errors: [...CREATE_ERRORS],
    handler: async ({ ctx, identity, body, log }) => {
      requirePortal(ctx);
      const userId = signedIn(identity);
      if (childAccount(identity.age_band)) throw new ProblemError('CLIENT_CHILD_ACCOUNT');
      const result = await createClient(ctx.db, {
        ownerUserId: userId,
        name: body.name,
        description: body.description,
        type: body.type,
        redirect_uris: body.redirect_uris,
        require_par: body.require_par,
        backchannel_logout_uri: body.backchannel_logout_uri,
        backchannel_logout_session_required: body.backchannel_logout_session_required,
        actor: { type: 'user', id: userId },
        now: new Date(),
        productName: ctx.config.branding.product_name,
        maxClients: ctx.config.oidc.developer_portal.max_clients_per_user,
        checkText: (text, context) => checkClientText(ctx, text, context),
      });
      if (result.status !== 'ok') writeError(result);
      ctx.outbox.wake();
      log.info('oauth client created', { client_id: result.client.client_id });
      return {
        status: 201,
        headers: NO_STORE,
        body: presentedSecret(result.client, result.secret),
      };
    },
  });

  router.route({
    method: 'GET',
    path: `${CLIENTS_PATH}/:client_id`,
    operation_id: 'getOauthClient',
    summary: 'An OAuth client owned by the signed-in user',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: clientIdParam },
    responses: { 200: { description: 'The client', schema: clientSchema } },
    errors: [...PORTAL_ERRORS, 'CLIENT_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      requirePortal(ctx);
      const client = await getOwnedClient(ctx.db, signedIn(identity), params.client_id);
      if (!client) throw new ProblemError('CLIENT_NOT_FOUND');
      return { status: 200, headers: NO_STORE, body: presented(client) };
    },
  });

  router.route({
    method: 'PATCH',
    path: `${CLIENTS_PATH}/:client_id`,
    operation_id: 'updateOauthClient',
    summary: 'Edit an OAuth client owned by the signed-in user',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: clientIdParam, body: updateBody },
    responses: { 200: { description: 'The updated client', schema: clientSchema } },
    errors: [...UPDATE_ERRORS],
    handler: async ({ ctx, identity, params, body }) => {
      requirePortal(ctx);
      const userId = signedIn(identity);
      const result = await updateClient(ctx.db, {
        ownerUserId: userId,
        clientId: params.client_id,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.redirect_uris === undefined ? {} : { redirect_uris: body.redirect_uris }),
        ...(body.require_par === undefined ? {} : { require_par: body.require_par }),
        ...(body.backchannel_logout_uri === undefined
          ? {}
          : { backchannel_logout_uri: body.backchannel_logout_uri }),
        ...(body.backchannel_logout_session_required === undefined
          ? {}
          : { backchannel_logout_session_required: body.backchannel_logout_session_required }),
        actor: { type: 'user', id: userId },
        now: new Date(),
        productName: ctx.config.branding.product_name,
        checkText: (text, context) => checkClientText(ctx, text, context),
      });
      if (result.status !== 'ok') writeError(result);
      ctx.outbox.wake();
      return { status: 200, headers: NO_STORE, body: presented(result.client) };
    },
  });

  router.route({
    method: 'DELETE',
    path: `${CLIENTS_PATH}/:client_id`,
    operation_id: 'deleteOauthClient',
    summary: 'Delete an OAuth client owned by the signed-in user',
    tags: ['oidc'],
    auth: 'session',
    rate_limit: 'global',
    request: { params: clientIdParam },
    responses: { 204: { description: 'The client was deleted' } },
    errors: [...PORTAL_ERRORS, 'CLIENT_NOT_FOUND'],
    handler: async ({ ctx, identity, params }) => {
      requirePortal(ctx);
      const userId = signedIn(identity);
      const result = await deleteClient(ctx.db, {
        ownerUserId: userId,
        clientId: params.client_id,
        actor: { type: 'user', id: userId },
      });
      if (result.status !== 'ok') writeError(result);
      ctx.outbox.wake();
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: `${CLIENTS_PATH}/:client_id/secret`,
    operation_id: 'regenerateOauthClientSecret',
    summary: 'Replace an OAuth client secret',
    description: 'The new secret is returned once. Needs step-up.',
    tags: ['oidc'],
    auth: 'session',
    step_up: true,
    rate_limit: 'global',
    request: { params: clientIdParam },
    responses: { 200: { description: 'The new secret', schema: createdSchema } },
    errors: [...PORTAL_ERRORS, 'CLIENT_NOT_FOUND', 'CLIENT_SECRET_NOT_APPLICABLE'],
    handler: async ({ ctx, identity, params, log }) => {
      requirePortal(ctx);
      const userId = signedIn(identity);
      const result = await regenerateSecret(ctx.db, {
        ownerUserId: userId,
        clientId: params.client_id,
        actor: { type: 'user', id: userId },
        now: new Date(),
      });
      if (result.status !== 'ok') writeError(result);
      ctx.outbox.wake();
      log.info('oauth client secret rotated', { client_id: result.client.client_id });
      return {
        status: 200,
        headers: NO_STORE,
        body: presentedSecret(result.client, result.secret),
      };
    },
  });

  router.route({
    method: 'POST',
    path: `${ADMIN_CLIENTS_PATH}/:client_id/verify`,
    operation_id: 'verifyOauthClient',
    summary: 'Mark an OAuth client as verified',
    tags: ['oidc'],
    auth: 'session',
    permissions: ['oidc.clients.verify'],
    rate_limit: 'global',
    request: { params: clientIdParam },
    responses: { 200: { description: 'The client is verified', schema: clientSchema } },
    errors: ['CLIENT_NOT_FOUND'],
    handler: async ({ ctx, identity, params, log }) => {
      const result = await verifyClient(ctx.db, {
        clientId: params.client_id,
        actor: { type: 'user', id: signedIn(identity) },
        now: new Date(),
      });
      if (result.status !== 'ok') writeError(result);
      ctx.outbox.wake();
      log.info('oauth client verified', { client_id: result.client.client_id });
      return { status: 200, headers: NO_STORE, body: presented(result.client) };
    },
  });

  router.route({
    method: 'POST',
    path: `${ADMIN_CLIENTS_PATH}/:client_id/suspend`,
    operation_id: 'suspendOauthClient',
    summary: 'Suspend an OAuth client and revoke its tokens',
    tags: ['oidc'],
    auth: 'session',
    permissions: ['oidc.clients.suspend'],
    rate_limit: 'global',
    request: { params: clientIdParam },
    responses: { 200: { description: 'The client is suspended', schema: clientSchema } },
    errors: ['CLIENT_NOT_FOUND'],
    handler: async ({ ctx, identity, params, log }) => {
      const result = await suspendClient(ctx.db, {
        clientId: params.client_id,
        actor: { type: 'user', id: signedIn(identity) },
        now: new Date(),
      });
      if (result.status !== 'ok') writeError(result);
      ctx.outbox.wake();
      log.info('oauth client suspended', { client_id: result.client.client_id });
      return { status: 200, headers: NO_STORE, body: presented(result.client) };
    },
  });

  router.route({
    method: 'POST',
    path: `${ADMIN_CLIENTS_PATH}/:client_id/unsuspend`,
    operation_id: 'unsuspendOauthClient',
    summary: 'Lift a suspension on an OAuth client',
    tags: ['oidc'],
    auth: 'session',
    permissions: ['oidc.clients.suspend'],
    rate_limit: 'global',
    request: { params: clientIdParam },
    responses: { 200: { description: 'The client may issue tokens again', schema: clientSchema } },
    errors: ['CLIENT_NOT_FOUND'],
    handler: async ({ ctx, identity, params, log }) => {
      const result = await unsuspendClient(ctx.db, {
        clientId: params.client_id,
        actor: { type: 'user', id: signedIn(identity) },
        now: new Date(),
      });
      if (result.status !== 'ok') writeError(result);
      ctx.outbox.wake();
      log.info('oauth client unsuspended', { client_id: result.client.client_id });
      return { status: 200, headers: NO_STORE, body: presented(result.client) };
    },
  });
}
