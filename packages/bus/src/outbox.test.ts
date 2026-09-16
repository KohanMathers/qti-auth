import { validateEnvelope } from '@qtiauth/events';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { createEvent, writeEvent } from './outbox.ts';

const input = {
  type: 'qtiauth.identity.user.banned.v1',
  actor: { type: 'user' as const, id: 'staff-1' },
  subject: { type: 'user', id: 'user-1' },
  data: { reason: 'spam' },
};

describe('createEvent', () => {
  it('builds a valid envelope', () => {
    const occurredAt = new Date('2026-09-16T12:00:00Z');
    const event = createEvent({ ...input, occurredAt, traceId: 'a'.repeat(32) });
    expect(event).toMatchObject({
      type: input.type,
      occurred_at: '2026-09-16T12:00:00.000Z',
      actor: input.actor,
      subject: input.subject,
      data: input.data,
      trace_id: 'a'.repeat(32),
    });
    expect(event.event_id).toMatch(/^01M2N1D3G0[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(validateEnvelope(event).valid).toBe(true);
    expect(createEvent(input).trace_id).toBeNull();
  });

  it('rejects types outside the naming convention', () => {
    expect(() => createEvent({ ...input, type: 'user.banned' })).toThrow('must look like');
  });
});

describe('writeEvent', () => {
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  it('refuses to write outside a transaction', async () => {
    await expect(writeEvent(db, input)).rejects.toThrow(
      'writeEvent must run inside the transaction that changes the state',
    );
  });

  it('refuses an invalid envelope', async () => {
    await expect(
      db.transaction().execute((trx) => writeEvent(trx, { ...input, traceId: 'not-a-trace' })),
    ).rejects.toThrow('Invalid qtiauth.identity.user.banned.v1 event: /trace_id:');
  });
});
