import { assertEventContract, type EventCatalog, type EventEnvelope } from '@qtiauth/events';
import { type Kysely, sql } from 'kysely';

export async function outboxEvents<DB>(db: Kysely<DB>): Promise<EventEnvelope[]> {
  const { rows } = await sql<{ envelope: EventEnvelope }>`
    select envelope from outbox order by id
  `.execute(db);
  return rows.map((row) => row.envelope);
}

export async function checkOutboxContract<DB>(
  db: Kysely<DB>,
  catalog: EventCatalog,
): Promise<EventEnvelope[]> {
  const events = await outboxEvents(db);
  assertEventContract(catalog, events);
  return events;
}
