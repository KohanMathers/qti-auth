import {
  type EventActor,
  type EventEnvelope,
  type EventSubject,
  newEventId,
  parseEventType,
  validateEnvelope,
} from '@qtiauth/events';
import { currentTraceIds } from '@qtiauth/observability';
import { type Kysely, sql } from 'kysely';

import type { BusConfig } from './connect.ts';

export const OUTBOX_TABLE = 'outbox';
export const PROCESSED_EVENTS_TABLE = 'processed_events';

export class OutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxError';
  }
}

export interface NewEvent<Data extends object> {
  type: string;
  actor: EventActor;
  subject: EventSubject | null;
  data: Data;
  traceId?: string | null;
  spanId?: string | null;
  occurredAt?: Date;
}

export interface OutboxStats {
  backlog: number;
  oldestAgeSeconds: number;
}

export async function createBusTablesV1(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table outbox (
      id bigint generated always as identity primary key,
      event_id text not null unique,
      subject text not null,
      envelope jsonb not null,
      created_at timestamptz not null default now(),
      sent_at timestamptz
    )
  `.execute(db);
  await sql`create index outbox_unsent_idx on outbox (id) where sent_at is null`.execute(db);
  await sql`create index outbox_sent_at_idx on outbox (sent_at) where sent_at is not null`.execute(
    db,
  );
  await sql`
    create table processed_events (
      consumer text not null,
      event_id text not null,
      processed_at timestamptz not null default now(),
      primary key (consumer, event_id)
    )
  `.execute(db);
  await sql`create index processed_events_processed_at_idx on processed_events (processed_at)`.execute(
    db,
  );
}

export function createEvent<Data extends object>(input: NewEvent<Data>): EventEnvelope<Data> {
  parseEventType(input.type);
  const occurredAt = input.occurredAt ?? new Date();
  const trace =
    input.traceId === undefined
      ? currentTraceIds()
      : { traceId: input.traceId, spanId: input.spanId ?? null };
  return {
    event_id: newEventId(occurredAt.getTime()),
    type: input.type,
    occurred_at: occurredAt.toISOString(),
    actor: input.actor,
    subject: input.subject,
    data: input.data,
    trace_id: trace?.traceId ?? null,
    span_id: trace?.spanId ?? null,
  };
}

export async function writeEvent<DB, Data extends object>(
  trx: Kysely<DB>,
  input: NewEvent<Data>,
): Promise<EventEnvelope<Data>> {
  if (!trx.isTransaction) {
    throw new OutboxError('writeEvent must run inside the transaction that changes the state');
  }
  const event = createEvent(input);
  const result = validateEnvelope(event);
  if (!result.valid) {
    throw new OutboxError(`Invalid ${event.type} event: ${result.issues.join(', ')}`);
  }
  await sql`
    insert into outbox (event_id, subject, envelope)
    values (${event.event_id}, ${event.type}, ${JSON.stringify(event)}::jsonb)
  `.execute(trx);
  return event;
}

export async function outboxStats<DB>(db: Kysely<DB>): Promise<OutboxStats> {
  const { rows } = await sql<{ backlog: number; oldest_age: number | null }>`
    select count(*)::int as backlog,
      extract(epoch from now() - min(created_at))::float8 as oldest_age
    from outbox
    where sent_at is null
  `.execute(db);
  return { backlog: rows[0]?.backlog ?? 0, oldestAgeSeconds: rows[0]?.oldest_age ?? 0 };
}

export async function pruneBusTables<DB>(
  db: Kysely<DB>,
  config: BusConfig,
): Promise<{ outbox: number; processedEvents: number }> {
  const outbox = await sql`
    delete from outbox
    where sent_at < now() - make_interval(secs => ${config.outbox.sent_retention / 1000})
  `.execute(db);
  const processed = await sql`
    delete from processed_events
    where processed_at < now() - make_interval(secs => ${config.consumers.dedupe_retention / 1000})
  `.execute(db);
  return {
    outbox: Number(outbox.numAffectedRows ?? 0),
    processedEvents: Number(processed.numAffectedRows ?? 0),
  };
}
