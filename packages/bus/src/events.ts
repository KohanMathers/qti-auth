import { type EventCatalog, type EventEnvelope, validateEnvelope } from '@qtiauth/events';
import { type Kysely, sql, type Transaction } from 'kysely';

import type { Bus } from './connect.ts';
import {
  type ConsumerOptions,
  InvalidMessageError,
  parseJson,
  type RunningConsumer,
  runPullConsumer,
} from './consumer.ts';
import { EVENTS_STREAM } from './streams.ts';
import { consumerName } from './subjects.ts';

export interface EventConsumerOptions<DB> extends ConsumerOptions {
  name: string;
  types: readonly string[];
  handler: (event: EventEnvelope, trx: Transaction<DB>) => Promise<void>;
  startFrom?: 'all' | 'new';
  catalog?: EventCatalog;
}

export async function consumeEvents<DB>(
  bus: Bus,
  db: Kysely<DB>,
  options: EventConsumerOptions<DB>,
): Promise<RunningConsumer> {
  const name = consumerName(bus.service, options.name);
  return runPullConsumer(bus, {
    ...options,
    stream: EVENTS_STREAM,
    name,
    subjects: options.types,
    startFrom: options.startFrom ?? 'new',
    handle: async (msg) => {
      const value = parseJson(msg);
      const result = options.catalog ? options.catalog.validate(value) : validateEnvelope(value);
      if (!result.valid) {
        throw new InvalidMessageError(
          `Invalid event on ${msg.subject}: ${result.issues.join(', ')}`,
        );
      }
      const { event } = result;
      if (event.type !== msg.subject) {
        throw new InvalidMessageError(`Event type ${event.type} was published on ${msg.subject}`);
      }

      return db.transaction().execute(async (trx) => {
        const { rows } = await sql`
          insert into processed_events (consumer, event_id)
          values (${name}, ${event.event_id})
          on conflict do nothing
          returning event_id
        `.execute(trx);
        if (rows.length === 0) return 'duplicate';
        await options.handler(event, trx);
        return 'processed';
      });
    },
  });
}
