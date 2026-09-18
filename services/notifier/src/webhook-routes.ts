import {
  WEBHOOK_DESCRIPTION_MAX,
  WEBHOOK_FORMATS,
  WEBHOOK_SUBSCRIPTION_MESSAGE,
  isWebhookSubscription,
} from '@qtiauth/config';
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
  enqueueReplay,
  enqueueTest,
  getDelivery,
  listDeliveries,
  type SelectableDelivery,
} from './deliver.ts';
import {
  createEndpoint,
  deleteEndpoint,
  type EndpointRecord,
  type EndpointWriteError,
  getEndpoint,
  listEndpoints,
  rotateEndpointSecret,
  updateEndpoint,
} from './endpoints.ts';
import { NO_STORE } from './headers.ts';
import { accountOrigin } from './origin.ts';
import type { Context } from './service.ts';
import { webhookSecretHint } from './sign.ts';

const position = z.object({ created_at: z.iso.datetime(), id: z.uuid() });

const endpointSchema = z.object({
  id: z.uuid(),
  slug: z.string().nullable(),
  url: z.string(),
  description: z.string(),
  events: z.array(z.string()),
  format: z.enum(WEBHOOK_FORMATS),
  enabled: z.boolean(),
  consecutive_failures: z.int(),
  disabled_reason: z.string().nullable(),
  secret_hint: z.string(),
  previous_secret_expires_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

const createdSchema = endpointSchema.extend({ secret: z.string() });

const deliverySchema = z.object({
  id: z.uuid(),
  endpoint_id: z.uuid(),
  event_id: z.string(),
  event_type: z.string(),
  trigger: z.enum(['event', 'test', 'replay']),
  replay_of: z.uuid().nullable(),
  status: z.enum(['retrying', 'sent', 'failed']),
  attempts: z.int(),
  queued_at: z.iso.datetime(),
  sent_at: z.iso.datetime().nullable(),
  last_error: z.string().nullable(),
  request_url: z.string().nullable(),
  request_headers: z.record(z.string(), z.string()).nullable(),
  request_body: z.string().nullable(),
  response_status: z.int().nullable(),
  response_headers: z.record(z.string(), z.string()).nullable(),
  response_body: z.string().nullable(),
});

const createBody = z.object({
  url: z.string().min(1),
  description: z.string().trim().min(1).max(WEBHOOK_DESCRIPTION_MAX),
  events: z.array(z.string().refine(isWebhookSubscription, WEBHOOK_SUBSCRIPTION_MESSAGE)).min(1),
  format: z.enum(WEBHOOK_FORMATS).default('standard'),
  enabled: z.boolean().default(true),
});

function signedIn(identity: { sub: string | null }): { userId: string } {
  if (identity.sub === null) throw new ProblemError('IDENTITY_TOKEN_INVALID');
  return { userId: identity.sub };
}

function presented(endpoint: EndpointRecord) {
  return {
    id: endpoint.id,
    slug: endpoint.slug,
    url: endpoint.url,
    description: endpoint.description,
    events: endpoint.events,
    format: endpoint.format,
    enabled: endpoint.enabled,
    consecutive_failures: endpoint.consecutive_failures,
    disabled_reason: endpoint.disabled_reason,
    secret_hint: webhookSecretHint(endpoint.secret),
    previous_secret_expires_at: endpoint.previous_secret_expires_at?.toISOString() ?? null,
    created_at: endpoint.created_at.toISOString(),
    updated_at: endpoint.updated_at.toISOString(),
  };
}

function presentedSecret(endpoint: EndpointRecord, secret: string) {
  return { ...presented(endpoint), secret };
}

function presentedDelivery(row: SelectableDelivery) {
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    event_id: row.event_id,
    event_type: row.event_type,
    trigger: row.trigger,
    replay_of: row.replay_of,
    status: row.status,
    attempts: row.attempts,
    queued_at: row.queued_at.toISOString(),
    sent_at: row.sent_at?.toISOString() ?? null,
    last_error: row.last_error,
    request_url: row.request_url,
    request_headers: row.request_headers,
    request_body: row.request_body,
    response_status: row.response_status,
    response_headers: row.response_headers,
    response_body: row.response_body,
  };
}

function writeError(result: EndpointWriteError): never {
  switch (result.status) {
    case 'not_found':
      throw new ProblemError('WEBHOOK_ENDPOINT_NOT_FOUND');
    case 'invalid_url':
      throw new ProblemError('WEBHOOK_TARGET_INVALID', { detail: result.message });
    case 'invalid_events':
      throw new ProblemError('VALIDATION_FAILED', {
        detail: `Event subscription ${result.pattern} is not valid`,
      });
  }
}

export function webhookRoutes(router: Router<Context>): void {
  router.route({
    method: 'GET',
    path: '/api/v1/admin/webhooks',
    operation_id: 'listWebhookEndpoints',
    summary: 'Outbound webhook endpoints',
    tags: ['webhooks'],
    auth: 'session',
    permissions: ['webhooks.manage'],
    rate_limit: 'global',
    responses: {
      200: { description: 'Endpoints', schema: z.object({ items: z.array(endpointSchema) }) },
    },
    handler: async ({ ctx }) => {
      const endpoints = await listEndpoints(ctx.db);
      return {
        status: 200,
        headers: NO_STORE,
        body: { items: endpoints.map((endpoint) => presented(endpoint)) },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/webhooks',
    operation_id: 'createWebhookEndpoint',
    summary: 'Create a webhook endpoint',
    description: 'The signing secret is returned once. Discord and Slack URLs can be pasted as-is.',
    tags: ['webhooks'],
    auth: 'session',
    permissions: ['webhooks.manage'],
    step_up: true,
    rate_limit: 'global',
    request: { body: createBody },
    responses: { 201: { description: 'The endpoint was created', schema: createdSchema } },
    errors: ['WEBHOOK_TARGET_INVALID'],
    handler: async ({ ctx, identity, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await createEndpoint(ctx.db, {
        url: body.url,
        description: body.description,
        events: body.events,
        format: body.format,
        enabled: body.enabled,
        actor: { type: 'user', id: userId },
        allowPrivate: ctx.config.webhooks.allow_private_targets,
        now: new Date(),
      });
      if (result.status !== 'ok') writeError(result);
      ctx.outbox.wake();
      log.info('webhook endpoint created', { endpoint_id: result.endpoint.id });
      return {
        status: 201,
        headers: NO_STORE,
        body: presentedSecret(result.endpoint, result.secret),
      };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/webhooks/:endpoint_id',
    operation_id: 'getWebhookEndpoint',
    summary: 'A webhook endpoint',
    tags: ['webhooks'],
    auth: 'session',
    permissions: ['webhooks.manage'],
    rate_limit: 'global',
    request: { params: z.object({ endpoint_id: z.uuid() }) },
    responses: { 200: { description: 'The endpoint', schema: endpointSchema } },
    errors: ['WEBHOOK_ENDPOINT_NOT_FOUND'],
    handler: async ({ ctx, params }) => {
      const endpoint = await getEndpoint(ctx.db, params.endpoint_id);
      if (!endpoint) throw new ProblemError('WEBHOOK_ENDPOINT_NOT_FOUND');
      return { status: 200, headers: NO_STORE, body: presented(endpoint) };
    },
  });

  router.route({
    method: 'PATCH',
    path: '/api/v1/admin/webhooks/:endpoint_id',
    operation_id: 'updateWebhookEndpoint',
    summary: 'Edit a webhook endpoint',
    tags: ['webhooks'],
    auth: 'session',
    permissions: ['webhooks.manage'],
    step_up: true,
    rate_limit: 'global',
    request: {
      params: z.object({ endpoint_id: z.uuid() }),
      body: z
        .object({
          url: z.string().min(1).optional(),
          description: z.string().trim().min(1).max(WEBHOOK_DESCRIPTION_MAX).optional(),
          events: z
            .array(z.string().refine(isWebhookSubscription, WEBHOOK_SUBSCRIPTION_MESSAGE))
            .min(1)
            .optional(),
          format: z.enum(WEBHOOK_FORMATS).optional(),
          enabled: z.boolean().optional(),
        })
        .refine(
          (body) =>
            body.url !== undefined ||
            body.description !== undefined ||
            body.events !== undefined ||
            body.format !== undefined ||
            body.enabled !== undefined,
          { message: 'Set url, description, events, format or enabled' },
        ),
    },
    responses: { 200: { description: 'The endpoint was updated', schema: endpointSchema } },
    errors: ['WEBHOOK_ENDPOINT_NOT_FOUND', 'WEBHOOK_TARGET_INVALID'],
    handler: async ({ ctx, identity, params, body, log }) => {
      const { userId } = signedIn(identity);
      const result = await updateEndpoint(ctx.db, {
        id: params.endpoint_id,
        actor: { type: 'user', id: userId },
        allowPrivate: ctx.config.webhooks.allow_private_targets,
        now: new Date(),
        ...(body.url === undefined ? {} : { url: body.url }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.events === undefined ? {} : { events: body.events }),
        ...(body.format === undefined ? {} : { format: body.format }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      });
      if (result.status !== 'ok') writeError(result);
      ctx.outbox.wake();
      log.info('webhook endpoint updated', { endpoint_id: result.endpoint.id });
      return { status: 200, headers: NO_STORE, body: presented(result.endpoint) };
    },
  });

  router.route({
    method: 'DELETE',
    path: '/api/v1/admin/webhooks/:endpoint_id',
    operation_id: 'deleteWebhookEndpoint',
    summary: 'Delete a webhook endpoint',
    tags: ['webhooks'],
    auth: 'session',
    permissions: ['webhooks.manage'],
    step_up: true,
    rate_limit: 'global',
    request: { params: z.object({ endpoint_id: z.uuid() }) },
    responses: { 204: { description: 'The endpoint was deleted' } },
    errors: ['WEBHOOK_ENDPOINT_NOT_FOUND'],
    handler: async ({ ctx, identity, params, log }) => {
      const { userId } = signedIn(identity);
      const result = await deleteEndpoint(ctx.db, {
        id: params.endpoint_id,
        actor: { type: 'user', id: userId },
      });
      if (result.status !== 'ok') writeError(result);
      ctx.outbox.wake();
      log.info('webhook endpoint deleted', { endpoint_id: params.endpoint_id });
      return { status: 204, headers: NO_STORE };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/webhooks/:endpoint_id/secret',
    operation_id: 'rotateWebhookSecret',
    summary: 'Rotate the signing secret',
    description:
      'The previous secret stays valid for webhooks.secret_overlap. The new secret is returned once.',
    tags: ['webhooks'],
    auth: 'session',
    permissions: ['webhooks.manage'],
    step_up: true,
    rate_limit: 'global',
    request: { params: z.object({ endpoint_id: z.uuid() }) },
    responses: { 200: { description: 'The secret was rotated', schema: createdSchema } },
    errors: ['WEBHOOK_ENDPOINT_NOT_FOUND'],
    handler: async ({ ctx, identity, params, log }) => {
      const { userId } = signedIn(identity);
      const result = await rotateEndpointSecret(ctx.db, {
        id: params.endpoint_id,
        actor: { type: 'user', id: userId },
        overlap: ctx.config.webhooks.secret_overlap,
        now: new Date(),
      });
      if (result.status !== 'ok') writeError(result);
      ctx.outbox.wake();
      log.info('webhook secret rotated', { endpoint_id: result.endpoint.id });
      return {
        status: 200,
        headers: NO_STORE,
        body: presentedSecret(result.endpoint, result.secret),
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/webhooks/:endpoint_id/test',
    operation_id: 'testWebhookEndpoint',
    summary: 'Send a test event to the endpoint',
    tags: ['webhooks'],
    auth: 'session',
    permissions: ['webhooks.manage'],
    step_up: true,
    rate_limit: 'global',
    request: { params: z.object({ endpoint_id: z.uuid() }) },
    responses: {
      202: { description: 'The test was queued', schema: z.object({ delivery_id: z.uuid() }) },
    },
    errors: ['WEBHOOK_ENDPOINT_NOT_FOUND'],
    handler: async ({ ctx, params, log }) => {
      const endpoint = await getEndpoint(ctx.db, params.endpoint_id);
      if (!endpoint) throw new ProblemError('WEBHOOK_ENDPOINT_NOT_FOUND');
      const deliveryId = await enqueueTest(ctx.db, endpoint, {
        origin: accountOrigin(ctx.config.surfaces),
        now: new Date(),
      });
      log.info('webhook test queued', { endpoint_id: endpoint.id, delivery_id: deliveryId });
      return { status: 202, headers: NO_STORE, body: { delivery_id: deliveryId } };
    },
  });

  router.route({
    method: 'GET',
    path: '/api/v1/admin/webhooks/:endpoint_id/deliveries',
    operation_id: 'listWebhookDeliveries',
    summary: 'Delivery log for an endpoint',
    tags: ['webhooks'],
    auth: 'session',
    permissions: ['webhooks.manage'],
    rate_limit: 'global',
    request: {
      params: z.object({ endpoint_id: z.uuid() }),
      query: paginationQuery({ defaultLimit: 50, maxLimit: 100 }),
    },
    responses: { 200: { description: 'Deliveries', schema: pageSchema(deliverySchema) } },
    errors: ['WEBHOOK_ENDPOINT_NOT_FOUND'],
    handler: async ({ ctx, params, query }) => {
      const endpoint = await getEndpoint(ctx.db, params.endpoint_id);
      if (!endpoint) throw new ProblemError('WEBHOOK_ENDPOINT_NOT_FOUND');
      const after = decodeCursor(position, query.cursor);
      const rows = await listDeliveries(ctx.db, {
        endpointId: params.endpoint_id,
        limit: query.limit,
        ...(after === undefined ? {} : { after }),
      });
      const page = pageOf(rows, query.limit, (row) => ({
        created_at: row.created_at.toISOString(),
        id: row.id,
      }));
      return {
        status: 200,
        headers: NO_STORE,
        body: { items: page.items.map(presentedDelivery), next_cursor: page.next_cursor },
      };
    },
  });

  router.route({
    method: 'POST',
    path: '/api/v1/admin/webhooks/:endpoint_id/deliveries/:delivery_id/replay',
    operation_id: 'replayWebhookDelivery',
    summary: 'Replay a delivery',
    tags: ['webhooks'],
    auth: 'session',
    permissions: ['webhooks.manage'],
    step_up: true,
    rate_limit: 'global',
    request: { params: z.object({ endpoint_id: z.uuid(), delivery_id: z.uuid() }) },
    responses: {
      202: { description: 'The replay was queued', schema: z.object({ delivery_id: z.uuid() }) },
    },
    errors: ['WEBHOOK_ENDPOINT_NOT_FOUND', 'WEBHOOK_DELIVERY_NOT_FOUND'],
    handler: async ({ ctx, params, log }) => {
      const endpoint = await getEndpoint(ctx.db, params.endpoint_id);
      if (!endpoint) throw new ProblemError('WEBHOOK_ENDPOINT_NOT_FOUND');
      const delivery = await getDelivery(ctx.db, params.delivery_id);
      if (delivery?.endpoint_id !== params.endpoint_id) {
        throw new ProblemError('WEBHOOK_DELIVERY_NOT_FOUND');
      }
      const deliveryId = await enqueueReplay(ctx.db, delivery, { now: new Date() });
      if (deliveryId === undefined) throw new ProblemError('WEBHOOK_ENDPOINT_NOT_FOUND');
      log.info('webhook delivery replayed', {
        endpoint_id: endpoint.id,
        delivery_id: deliveryId,
        replay_of: delivery.id,
      });
      return { status: 202, headers: NO_STORE, body: { delivery_id: deliveryId } };
    },
  });
}
