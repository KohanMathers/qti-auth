import { randomUUIDv7 } from 'node:crypto';

import type { QueueEmailRequest } from '@qtiauth/email';
import { newEventId, type EventEnvelope } from '@qtiauth/events';
import type { Logger } from '@qtiauth/observability';
import { type Kysely, type Selectable, sql } from 'kysely';

import type { Database, WebhookDeliveriesTable, WebhookTrigger } from './database.ts';
import type { DeliveryStatus } from './deliveries.ts';
import { errorSummary } from './deliveries.ts';
import {
  type EndpointRecord,
  getEndpoint,
  recordEndpointResult,
  signingSecrets,
} from './endpoints.ts';
import { endpointMatches, isDeliverableEvent } from './event-names.ts';
import type { WebhookHttp } from './http.ts';
import { type NotifierMetrics, noopNotifierMetrics } from './metrics.ts';
import {
  discordBody,
  slackBody,
  standardBody,
  type WebhookPayload,
  webhookPayload,
} from './payload.ts';
import { webhookMessageId, webhookSignatureHeader } from './sign.ts';

export const RETRY_JOB = 'webhooks.retry';
export const MAX_LOG_BODY = 2048;
const DUE_BATCH = 25;

export interface WebhookQueueConfig {
  allow_private_targets: boolean;
  disable_after_failures: number;
  timeout: number;
  retry_window: number;
  retry_delay: number;
  max_retry_delay: number;
}

export interface WebhookSenderOptions {
  db: Kysely<Database>;
  http: WebhookHttp;
  config: WebhookQueueConfig;
  origin: string | undefined;
  alertEmail: string;
  locale: string;
  queueAlert: (request: QueueEmailRequest<'webhook_disabled'>) => Promise<unknown>;
  log: Logger;
  metrics?: NotifierMetrics;
  now?: () => Date;
}

function truncate(value: string): string {
  return value.length <= MAX_LOG_BODY ? value : value.slice(0, MAX_LOG_BODY);
}

function redactUrl(url: string): string {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/');
  if (parts.length > 2) parts[parts.length - 1] = '***';
  parsed.pathname = parts.join('/');
  return parsed.toString();
}

function encodedBody(endpoint: EndpointRecord, payload: WebhookPayload): string {
  switch (endpoint.format) {
    case 'discord':
      return discordBody(payload);
    case 'slack':
      return slackBody(payload);
    case 'standard':
      return standardBody(payload);
  }
}

function retryDelay(attempts: number, config: WebhookQueueConfig): number {
  return Math.min(config.retry_delay * 2 ** Math.max(0, attempts - 1), config.max_retry_delay);
}

function deliveryHeaders(
  endpoint: EndpointRecord,
  deliveryId: string,
  timestamp: number,
  body: string,
  now: Date,
): Record<string, string> {
  if (endpoint.format !== 'standard') return {};
  const id = webhookMessageId(deliveryId);
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': webhookSignatureHeader(signingSecrets(endpoint, now), id, timestamp, body),
  };
}

export async function enqueueEvent(
  db: Kysely<Database>,
  event: EventEnvelope,
  options: { origin: string | undefined; now: Date },
): Promise<number> {
  const type = isDeliverableEvent(event);
  if (type === undefined) return 0;
  const endpoints = await db
    .selectFrom('webhook_endpoints')
    .selectAll()
    .where('enabled', '=', true)
    .execute();
  const payload = webhookPayload(event, type, options.origin);
  let queued = 0;
  for (const row of endpoints) {
    const events = Array.isArray(row.events) ? row.events.map(String) : [];
    if (!endpointMatches(events, type)) continue;
    await db
      .insertInto('webhook_deliveries')
      .values({
        id: randomUUIDv7(),
        endpoint_id: row.id,
        event_id: event.event_id,
        event_type: type,
        trigger: 'event',
        replay_of: null,
        subject_type: event.subject?.type ?? null,
        subject_id: event.subject?.id ?? null,
        payload,
        status: 'retrying',
        attempts: 0,
        next_attempt_at: options.now,
        queued_at: options.now,
        sent_at: null,
        last_error: null,
        request_url: null,
        request_headers: null,
        request_body: null,
        response_status: null,
        response_headers: null,
        response_body: null,
        created_at: options.now,
        updated_at: options.now,
      })
      .execute();
    queued += 1;
  }
  return queued;
}

export async function enqueueTest(
  db: Kysely<Database>,
  endpoint: EndpointRecord,
  options: { origin: string | undefined; now: Date },
): Promise<string> {
  const id = randomUUIDv7();
  const payload = webhookPayload(
    {
      event_id: newEventId(options.now.getTime()),
      occurred_at: options.now.toISOString(),
      subject: null,
      data: { endpoint_id: endpoint.id },
    },
    'webhook.test',
    options.origin,
  );
  await db
    .insertInto('webhook_deliveries')
    .values({
      id,
      endpoint_id: endpoint.id,
      event_id: payload.event_id,
      event_type: 'webhook.test',
      trigger: 'test',
      replay_of: null,
      subject_type: null,
      subject_id: null,
      payload,
      status: 'retrying',
      attempts: 0,
      next_attempt_at: options.now,
      queued_at: options.now,
      sent_at: null,
      last_error: null,
      request_url: null,
      request_headers: null,
      request_body: null,
      response_status: null,
      response_headers: null,
      response_body: null,
      created_at: options.now,
      updated_at: options.now,
    })
    .execute();
  return id;
}

export async function enqueueReplay(
  db: Kysely<Database>,
  delivery: SelectableDelivery,
  options: { now: Date },
): Promise<string | undefined> {
  const endpoint = await getEndpoint(db, delivery.endpoint_id);
  if (endpoint === undefined) return undefined;
  const id = randomUUIDv7();
  await db
    .insertInto('webhook_deliveries')
    .values({
      id,
      endpoint_id: delivery.endpoint_id,
      event_id: delivery.event_id,
      event_type: delivery.event_type,
      trigger: 'replay',
      replay_of: delivery.id,
      subject_type: delivery.subject_type,
      subject_id: delivery.subject_id,
      payload: delivery.payload,
      status: 'retrying',
      attempts: 0,
      next_attempt_at: options.now,
      queued_at: options.now,
      sent_at: null,
      last_error: null,
      request_url: null,
      request_headers: null,
      request_body: null,
      response_status: null,
      response_headers: null,
      response_body: null,
      created_at: options.now,
      updated_at: options.now,
    })
    .execute();
  return id;
}

type SelectableDelivery = Selectable<WebhookDeliveriesTable>;

function payloadOf(value: unknown): WebhookPayload {
  return value as WebhookPayload;
}

export function createWebhookSender(options: WebhookSenderOptions) {
  const metrics = options.metrics ?? noopNotifierMetrics;
  const nowOf = options.now ?? (() => new Date());

  async function attempt(row: SelectableDelivery): Promise<void> {
    const now = nowOf();
    const endpoint = await getEndpoint(options.db, row.endpoint_id);
    if (endpoint === undefined) {
      await options.db
        .updateTable('webhook_deliveries')
        .set({ status: 'failed', last_error: 'Endpoint was deleted', updated_at: now })
        .where('id', '=', row.id)
        .execute();
      return;
    }
    const payload = payloadOf(row.payload);
    const body = encodedBody(endpoint, payload);
    const timestamp = Math.floor(now.getTime() / 1000);
    const headers = deliveryHeaders(endpoint, row.id, timestamp, body, now);
    const started = performance.now();
    const attempts = row.attempts + 1;
    let status: DeliveryStatus = 'retrying';
    let lastError: string | null;
    let responseStatus: number | null = null;
    let responseHeaders: Record<string, string> | null = null;
    let responseBody: string | null = null;
    let outcome: 'ok' | 'error' = 'error';

    try {
      const response = await options.http({
        url: endpoint.url,
        headers,
        body,
        timeout: options.config.timeout,
        allowPrivate: options.config.allow_private_targets,
      });
      responseStatus = response.status;
      responseHeaders = response.headers;
      responseBody = truncate(response.body);
      if (response.status >= 200 && response.status < 300) {
        status = 'sent';
        lastError = null;
        outcome = 'ok';
      } else {
        lastError = `HTTP ${String(response.status)}`;
      }
    } catch (error) {
      lastError = errorSummary(error);
    }

    const elapsed = (performance.now() - started) / 1000;
    metrics.webhookAttempt(endpoint.format, outcome, elapsed);
    if (status === 'sent') {
      metrics.webhookDeliveryDelay(
        endpoint.format,
        (now.getTime() - row.queued_at.getTime()) / 1000,
      );
    } else {
      const deadline = row.queued_at.getTime() + options.config.retry_window;
      const next = now.getTime() + retryDelay(attempts, options.config);
      if (next > deadline) status = 'failed';
    }
    metrics.webhookDelivery(endpoint.format, status);

    await options.db
      .updateTable('webhook_deliveries')
      .set({
        status,
        attempts,
        next_attempt_at:
          status === 'retrying'
            ? new Date(now.getTime() + retryDelay(attempts, options.config))
            : null,
        sent_at: status === 'sent' ? now : null,
        last_error: lastError,
        request_url: redactUrl(endpoint.url),
        request_headers: headers,
        request_body: truncate(body),
        response_status: responseStatus,
        response_headers: responseHeaders,
        response_body: responseBody,
        updated_at: now,
      })
      .where('id', '=', row.id)
      .where('status', '!=', 'sent')
      .execute();

    const result = await recordEndpointResult(options.db, {
      id: endpoint.id,
      ok: status === 'sent',
      disableAfter: options.config.disable_after_failures,
      now,
    });
    if (result.disabled && result.endpoint) {
      options.log.warn('webhook endpoint disabled after consecutive failures', {
        endpoint_id: endpoint.id,
        failures: result.endpoint.consecutive_failures,
      });
      metrics.webhookDisabled(endpoint.format);
      try {
        await options.queueAlert({
          template: 'webhook_disabled',
          to: { address: options.alertEmail },
          locale: options.locale,
          variables: {
            description: endpoint.description,
            host: new URL(endpoint.url).host,
            failures: result.endpoint.consecutive_failures,
            link: options.origin
              ? new URL(`/admin/webhooks/${endpoint.id}`, options.origin).toString()
              : `https://localhost/admin/webhooks/${endpoint.id}`,
          },
        });
      } catch (error) {
        options.log.error('webhook disable email failed', { error, endpoint_id: endpoint.id });
      }
    }
    if (status !== 'sent') {
      options.log.warn('webhook delivery failed', {
        delivery_id: row.id,
        endpoint_id: endpoint.id,
        attempt: attempts,
        status,
      });
    }
  }

  return {
    attemptDue: async (): Promise<number> => {
      const now = nowOf();
      const { rows } = await sql<SelectableDelivery>`
        select * from webhook_deliveries
        where status = 'retrying' and next_attempt_at <= ${now}
        order by next_attempt_at
        limit ${DUE_BATCH}
      `.execute(options.db);
      for (const row of rows) await attempt(row);
      return rows.length;
    },
    attemptId: async (id: string): Promise<void> => {
      const row = await options.db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (row !== undefined) await attempt(row);
    },
  };
}

export async function getDelivery(
  db: Kysely<Database>,
  id: string,
): Promise<SelectableDelivery | undefined> {
  const row = await db
    .selectFrom('webhook_deliveries')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row;
}

export async function listDeliveries(
  db: Kysely<Database>,
  options: {
    endpointId: string;
    after?: { created_at: string; id: string };
    limit: number;
  },
): Promise<SelectableDelivery[]> {
  let query = db
    .selectFrom('webhook_deliveries')
    .selectAll()
    .where('endpoint_id', '=', options.endpointId);
  if (options.after !== undefined) {
    const after = options.after;
    const createdAt = new Date(after.created_at);
    query = query.where((eb) =>
      eb.or([
        eb('created_at', '<', createdAt),
        eb.and([eb('created_at', '=', createdAt), eb('id', '<', after.id)]),
      ]),
    );
  }
  const rows = await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(options.limit + 1)
    .execute();
  return rows;
}

export async function exportWebhookDeliveries(db: Kysely<Database>, userId: string) {
  const rows = await db
    .selectFrom('webhook_deliveries')
    .select(['id', 'event_type', 'trigger', 'status', 'attempts', 'queued_at', 'sent_at'])
    .where('subject_type', '=', 'user')
    .where('subject_id', '=', userId)
    .orderBy('queued_at')
    .execute();
  return rows.map((row) => ({
    ...row,
    queued_at: row.queued_at.toISOString(),
    sent_at: row.sent_at?.toISOString() ?? null,
  }));
}

export async function eraseWebhookDeliveries(
  db: Kysely<Database>,
  userId: string,
): Promise<number> {
  const result = await db
    .deleteFrom('webhook_deliveries')
    .where('subject_type', '=', 'user')
    .where('subject_id', '=', userId)
    .execute();
  return result.reduce((total, row) => total + Number(row.numDeletedRows), 0);
}

export type { SelectableDelivery, WebhookTrigger };
