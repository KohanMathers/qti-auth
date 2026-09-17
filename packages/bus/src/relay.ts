import type { JetStreamClient } from '@nats-io/jetstream';
import { context, SpanKind } from '@opentelemetry/api';
import type { EventEnvelope } from '@qtiauth/events';
import { contextFromTraceIds, untraced, withSpan } from '@qtiauth/observability';
import { type Kysely, sql } from 'kysely';

import type { Bus } from './connect.ts';
import { type BusMetrics, noopBusMetrics } from './metrics.ts';
import { outboxStats } from './outbox.ts';
import { messagingAttributes, traceHeaders } from './tracing.ts';

const LOCK_NAMESPACE = 'qtiauth.outbox';

export interface RelayOptions {
  batchSize: number;
  metrics?: BusMetrics;
}

export interface OutboxRelay {
  wake: () => void;
  stop: () => Promise<void>;
}

export interface OutboxRelayOptions {
  onError: (error: unknown) => void;
  metrics?: BusMetrics;
}

export async function publishEvent(js: JetStreamClient, event: EventEnvelope): Promise<void> {
  const parent =
    event.trace_id === null || event.span_id === null
      ? context.active()
      : contextFromTraceIds(event.trace_id, event.span_id);
  await withSpan(
    `send ${event.type}`,
    { kind: SpanKind.PRODUCER, parent, attributes: messagingAttributes('send', event.type) },
    async () => {
      await js.publish(event.type, JSON.stringify(event), {
        msgID: event.event_id,
        headers: traceHeaders(),
      });
    },
  );
}

export async function relayOutbox<DB>(
  db: Kysely<DB>,
  js: JetStreamClient,
  options: RelayOptions,
): Promise<number> {
  const metrics = options.metrics ?? noopBusMetrics;
  const { published, failure } = await db.transaction().execute(async (trx) => {
    const { rows: lock } = await sql<{ locked: boolean }>`
      select pg_try_advisory_xact_lock(hashtext(${LOCK_NAMESPACE}), hashtext(current_schema())) as locked
    `.execute(trx);
    if (!lock[0]?.locked) return { published: 0, failure: undefined };

    // Hold the lock across publish so two relays can't send the same row. JetStream
    // dedupes on event_id if we crash after publish and send the row again.
    const { rows } = await sql<{ id: string; subject: string; envelope: EventEnvelope }>`
      select id, subject, envelope from outbox
      where sent_at is null
      order by id
      limit ${options.batchSize}
    `.execute(trx);

    const sent: string[] = [];
    let failure: Error | undefined;
    for (const row of rows) {
      try {
        await publishEvent(js, row.envelope);
      } catch (error) {
        metrics.publishFailed(row.subject);
        failure = error instanceof Error ? error : new Error(String(error));
        break;
      }
      metrics.published(row.subject);
      sent.push(row.id);
    }
    if (sent.length > 0) {
      await sql`update outbox set sent_at = now() where id = any(${sent}::bigint[])`.execute(trx);
    }
    return { published: sent.length, failure };
  });
  if (failure !== undefined) throw failure;
  return published;
}

export function startOutboxRelay<DB>(
  bus: Bus,
  db: Kysely<DB>,
  options: OutboxRelayOptions,
): OutboxRelay {
  const { poll_interval: pollInterval, batch_size: batchSize } = bus.config.outbox;
  const metrics = options.metrics ?? noopBusMetrics;
  const stopped = new AbortController();
  let wakeUp = (): void => undefined;

  const idle = (): Promise<void> =>
    new Promise((resolve) => {
      if (stopped.signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, pollInterval);
      function done(): void {
        clearTimeout(timer);
        wakeUp = () => undefined;
        resolve();
      }
      wakeUp = done;
    });

  const loop = async (): Promise<void> => {
    while (!stopped.signal.aborted) {
      let published = 0;
      try {
        published = await untraced(() => relayOutbox(db, bus.js, { batchSize, metrics }));
        if (published < batchSize) {
          const stats = await untraced(() => outboxStats(db));
          metrics.outboxBacklog(stats.backlog, stats.oldestAgeSeconds);
        }
      } catch (error) {
        options.onError(error);
      }
      if (published < batchSize) await idle();
    }
  };
  const done = loop();

  return {
    wake: () => {
      wakeUp();
    },
    stop: async () => {
      stopped.abort();
      wakeUp();
      await done;
    },
  };
}
