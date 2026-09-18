import { randomUUIDv7 } from 'node:crypto';

import { writeEvent, type NewEvent } from '@qtiauth/bus';
import { type WebhookFormat, isWebhookSubscription } from '@qtiauth/config';
import { deletedRows, updatedRows } from '@qtiauth/db';
import { AUDIT_EVENTS, type EventActor } from '@qtiauth/events';
import { type Kysely, type Selectable } from 'kysely';

import type { Database, WebhookEndpointsTable } from './database.ts';
import { generateWebhookSecret } from './sign.ts';
import { assertPublicWebhookUrl, type DnsLookup, WebhookTargetError } from './ssrf.ts';

export interface EndpointDefinition {
  url: string;
  description: string;
  events: readonly string[];
  format: WebhookFormat;
  secret: string;
  enabled: boolean;
}

export type EndpointRow = Selectable<WebhookEndpointsTable>;

export interface EndpointRecord {
  id: string;
  slug: string | null;
  url: string;
  description: string;
  events: string[];
  format: WebhookFormat;
  secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: Date | null;
  enabled: boolean;
  consecutive_failures: number;
  disabled_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export type EndpointWriteError =
  | { status: 'not_found' }
  | { status: 'invalid_url'; message: string }
  | { status: 'invalid_events'; pattern: string };

export type EndpointWriteResult = { status: 'ok'; endpoint: EndpointRecord } | EndpointWriteError;

export type EndpointSecretResult =
  { status: 'ok'; endpoint: EndpointRecord; secret: string } | EndpointWriteError;

interface AuditRecordedData {
  action: string;
  target_type: string;
  target_id: string;
}

function eventsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function presentedEndpoint(row: EndpointRow): EndpointRecord {
  return {
    ...row,
    events: eventsOf(row.events),
  };
}

function auditEvent(actor: EventActor, data: AuditRecordedData): NewEvent<AuditRecordedData> {
  return {
    type: AUDIT_EVENTS.recorded,
    actor,
    subject: { type: data.target_type, id: data.target_id },
    data,
  };
}

async function writeAudit(
  trx: Kysely<Database>,
  actor: EventActor,
  action: string,
  endpointId: string,
): Promise<void> {
  await writeEvent<Database, AuditRecordedData>(
    trx,
    auditEvent(actor, { action, target_type: 'webhook_endpoint', target_id: endpointId }),
  );
}

export function checkedSubscriptions(
  events: readonly string[],
): { events: string[] } | { invalid: string } {
  const unique = [...new Set(events)];
  const invalid = unique.find((pattern) => !isWebhookSubscription(pattern));
  if (invalid !== undefined) return { invalid };
  return { events: unique };
}

export async function seedEndpoints(
  db: Kysely<Database>,
  definitions: Record<string, EndpointDefinition>,
  options: { allowPrivate: boolean; lookup?: DnsLookup | undefined; now?: Date },
): Promise<void> {
  const now = options.now ?? new Date();
  for (const [slug, definition] of Object.entries(definitions)) {
    await assertPublicWebhookUrl(definition.url, {
      allowPrivate: options.allowPrivate,
      lookup: options.lookup,
    });
    const checked = checkedSubscriptions(definition.events);
    if ('invalid' in checked) {
      throw new WebhookTargetError(`webhooks.endpoints.${slug}.events: ${checked.invalid}`);
    }
    await db
      .insertInto('webhook_endpoints')
      .values({
        id: randomUUIDv7(),
        slug,
        url: definition.url,
        description: definition.description,
        events: checked.events,
        format: definition.format,
        secret: definition.secret === '' ? generateWebhookSecret() : definition.secret,
        previous_secret: null,
        previous_secret_expires_at: null,
        enabled: definition.enabled,
        consecutive_failures: 0,
        disabled_reason: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.column('slug').doNothing())
      .execute();
  }
}

export async function listEndpoints(db: Kysely<Database>): Promise<EndpointRecord[]> {
  const rows = await db
    .selectFrom('webhook_endpoints')
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.map(presentedEndpoint);
}

export async function listEnabledEndpoints(db: Kysely<Database>): Promise<EndpointRecord[]> {
  const rows = await db
    .selectFrom('webhook_endpoints')
    .selectAll()
    .where('enabled', '=', true)
    .execute();
  return rows.map(presentedEndpoint);
}

export async function getEndpoint(
  db: Kysely<Database>,
  id: string,
): Promise<EndpointRecord | undefined> {
  const row = await db
    .selectFrom('webhook_endpoints')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row === undefined ? undefined : presentedEndpoint(row);
}

export async function createEndpoint(
  db: Kysely<Database>,
  options: {
    url: string;
    description: string;
    events: readonly string[];
    format: WebhookFormat;
    enabled: boolean;
    actor: EventActor;
    allowPrivate: boolean;
    lookup?: DnsLookup | undefined;
    now: Date;
  },
): Promise<EndpointSecretResult> {
  const checked = checkedSubscriptions(options.events);
  if ('invalid' in checked) return { status: 'invalid_events', pattern: checked.invalid };
  try {
    await assertPublicWebhookUrl(options.url, {
      allowPrivate: options.allowPrivate,
      lookup: options.lookup,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'invalid_url', message };
  }
  const secret = generateWebhookSecret();
  const id = randomUUIDv7();
  return db.transaction().execute(async (trx) => {
    await trx
      .insertInto('webhook_endpoints')
      .values({
        id,
        slug: null,
        url: options.url,
        description: options.description,
        events: checked.events,
        format: options.format,
        secret,
        previous_secret: null,
        previous_secret_expires_at: null,
        enabled: options.enabled,
        consecutive_failures: 0,
        disabled_reason: null,
        created_at: options.now,
        updated_at: options.now,
      })
      .execute();
    await writeAudit(trx, options.actor, 'webhook.created', id);
    const endpoint = await getEndpoint(trx, id);
    if (endpoint === undefined) return { status: 'not_found' };
    return { status: 'ok', endpoint, secret };
  });
}

export async function updateEndpoint(
  db: Kysely<Database>,
  options: {
    id: string;
    url?: string;
    description?: string;
    events?: readonly string[];
    format?: WebhookFormat;
    enabled?: boolean;
    actor: EventActor;
    allowPrivate: boolean;
    lookup?: DnsLookup | undefined;
    now: Date;
  },
): Promise<EndpointWriteResult> {
  const existing = await getEndpoint(db, options.id);
  if (!existing) return { status: 'not_found' };
  let events = existing.events;
  if (options.events !== undefined) {
    const checked = checkedSubscriptions(options.events);
    if ('invalid' in checked) return { status: 'invalid_events', pattern: checked.invalid };
    events = checked.events;
  }
  const url = options.url ?? existing.url;
  try {
    await assertPublicWebhookUrl(url, {
      allowPrivate: options.allowPrivate,
      lookup: options.lookup,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'invalid_url', message };
  }
  const enabled = options.enabled ?? existing.enabled;
  return db.transaction().execute(async (trx) => {
    const result = await trx
      .updateTable('webhook_endpoints')
      .set({
        url,
        description: options.description ?? existing.description,
        events,
        format: options.format ?? existing.format,
        enabled,
        consecutive_failures: enabled && !existing.enabled ? 0 : existing.consecutive_failures,
        disabled_reason: enabled ? null : existing.disabled_reason,
        updated_at: options.now,
      })
      .where('id', '=', options.id)
      .executeTakeFirst();
    if (updatedRows(result) === 0) return { status: 'not_found' };
    await writeAudit(trx, options.actor, 'webhook.updated', options.id);
    const endpoint = await getEndpoint(trx, options.id);
    if (endpoint === undefined) return { status: 'not_found' };
    return { status: 'ok', endpoint };
  });
}

export async function deleteEndpoint(
  db: Kysely<Database>,
  options: { id: string; actor: EventActor },
): Promise<EndpointWriteResult> {
  return db.transaction().execute(async (trx) => {
    const existing = await getEndpoint(trx, options.id);
    if (!existing) return { status: 'not_found' };
    await writeAudit(trx, options.actor, 'webhook.deleted', options.id);
    await trx.deleteFrom('webhook_endpoints').where('id', '=', options.id).execute();
    return { status: 'ok', endpoint: existing };
  });
}

export async function rotateEndpointSecret(
  db: Kysely<Database>,
  options: { id: string; actor: EventActor; overlap: number; now: Date },
): Promise<EndpointSecretResult> {
  const secret = generateWebhookSecret();
  return db.transaction().execute(async (trx) => {
    const existing = await getEndpoint(trx, options.id);
    if (!existing) return { status: 'not_found' };
    await trx
      .updateTable('webhook_endpoints')
      .set({
        secret,
        previous_secret: existing.secret,
        previous_secret_expires_at: new Date(options.now.getTime() + options.overlap),
        updated_at: options.now,
      })
      .where('id', '=', options.id)
      .execute();
    await writeAudit(trx, options.actor, 'webhook.secret_rotated', options.id);
    const endpoint = await getEndpoint(trx, options.id);
    if (endpoint === undefined) return { status: 'not_found' };
    return { status: 'ok', endpoint, secret };
  });
}

export function signingSecrets(endpoint: EndpointRecord, now: Date): string[] {
  const secrets = [endpoint.secret];
  if (
    endpoint.previous_secret !== null &&
    endpoint.previous_secret_expires_at !== null &&
    endpoint.previous_secret_expires_at.getTime() > now.getTime()
  ) {
    secrets.push(endpoint.previous_secret);
  }
  return secrets;
}

export async function recordEndpointResult(
  db: Kysely<Database>,
  options: {
    id: string;
    ok: boolean;
    disableAfter: number;
    now: Date;
  },
): Promise<{ disabled: boolean; endpoint: EndpointRecord | undefined }> {
  const existing = await getEndpoint(db, options.id);
  if (!existing) return { disabled: false, endpoint: undefined };
  if (options.ok) {
    await db
      .updateTable('webhook_endpoints')
      .set({ consecutive_failures: 0, disabled_reason: null, updated_at: options.now })
      .where('id', '=', options.id)
      .execute();
    return { disabled: false, endpoint: await getEndpoint(db, options.id) };
  }
  const failures = existing.consecutive_failures + 1;
  const disable = failures >= options.disableAfter;
  await db
    .updateTable('webhook_endpoints')
    .set({
      consecutive_failures: failures,
      enabled: disable ? false : existing.enabled,
      disabled_reason: disable ? 'failures' : existing.disabled_reason,
      updated_at: options.now,
    })
    .where('id', '=', options.id)
    .execute();
  return { disabled: disable && existing.enabled, endpoint: await getEndpoint(db, options.id) };
}

export async function sweepWebhookDeliveries(
  db: Kysely<Database>,
  options: { retention: number; now: Date },
): Promise<number> {
  const cutoff = new Date(options.now.getTime() - options.retention);
  return deletedRows(
    await db
      .deleteFrom('webhook_deliveries')
      .where('created_at', '<', cutoff)
      .where('status', '!=', 'retrying')
      .execute(),
  );
}
