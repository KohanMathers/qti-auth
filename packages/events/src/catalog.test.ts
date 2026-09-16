import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertEventContract,
  eventSchemaId,
  loadEventCatalog,
  validateEnvelope,
} from './catalog.ts';
import type { EventEnvelope } from './envelope.ts';

const TYPE = 'qtiauth.identity.user.banned.v1';

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: '01J8ZQ4Y3N5W7R9T1V3X5Z7B9D',
    type: TYPE,
    occurred_at: '2026-09-16T12:00:00Z',
    actor: { type: 'user', id: 'staff-1' },
    subject: { type: 'user', id: 'user-1' },
    data: { reason: 'spam' },
    trace_id: null,
    ...overrides,
  };
}

let dir: string;

async function writeSchema(path: string, schema: object): Promise<void> {
  await mkdir(join(dir, path, '..'), { recursive: true });
  await writeFile(join(dir, path), JSON.stringify(schema));
}

const bannedSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: eventSchemaId(TYPE),
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: { reason: { type: 'string' } },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qtiauth-events-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('validateEnvelope', () => {
  it('accepts the envelope from the spec', () => {
    expect(validateEnvelope(event())).toEqual({ valid: true, event: event() });
    expect(validateEnvelope(event({ subject: null, trace_id: 'a'.repeat(32) })).valid).toBe(true);
  });

  it('names every problem', () => {
    const result = validateEnvelope({
      ...event(),
      event_id: 'not-a-ulid',
      occurred_at: 'yesterday',
      actor: { type: 'robot', id: 'x' },
      extra: true,
    });
    expect(result.valid).toBe(false);
    expect(!result.valid && result.issues).toEqual([
      '/: must NOT have additional properties',
      '/event_id: must match pattern "^[0-7][0-9A-HJKMNP-TV-Z]{25}$"',
      '/occurred_at: must match format "date-time"',
      '/actor/type: must be equal to one of the allowed values',
    ]);
  });
});

describe('loadEventCatalog', () => {
  it('ships valid schemas', async () => {
    await expect(loadEventCatalog()).resolves.toBeDefined();
  });

  it('validates data against the schema for its type', async () => {
    await writeSchema('identity/user.banned.v1.json', bannedSchema);
    const catalog = await loadEventCatalog(dir);

    expect(catalog.types).toEqual([TYPE]);
    expect(catalog.validate(event()).valid).toBe(true);
    expect(catalog.validate(event({ data: { reason: 1 } }))).toEqual({
      valid: false,
      issues: ['/data/reason: must be string'],
    });
    expect(catalog.validate(event({ type: 'qtiauth.identity.user.unbanned.v1' }))).toEqual({
      valid: false,
      issues: ['/type: no schema for event type qtiauth.identity.user.unbanned.v1'],
    });
  });

  it('enforces the file layout and $id convention', async () => {
    await writeSchema('user.banned.v1.json', bannedSchema);
    await expect(loadEventCatalog(dir)).rejects.toThrow(
      'Event schema user.banned.v1.json must be at <service>/<entity>.<verb>.v<n>.json',
    );
    await rm(join(dir, 'user.banned.v1.json'));

    await writeSchema('identity/user.banned.json', bannedSchema);
    await expect(loadEventCatalog(dir)).rejects.toThrow('must look like');
    await rm(join(dir, 'identity/user.banned.json'));

    await writeSchema('identity/user.banned.v2.json', bannedSchema);
    await expect(loadEventCatalog(dir)).rejects.toThrow(
      `must have "$id": "${eventSchemaId('qtiauth.identity.user.banned.v2')}"`,
    );
  });
});

describe('assertEventContract', () => {
  it('throws with every issue for events that break their schema', async () => {
    await writeSchema('identity/user.banned.v1.json', bannedSchema);
    const catalog = await loadEventCatalog(dir);

    expect(() => {
      assertEventContract(catalog, [event()]);
    }).not.toThrow();
    expect(() => {
      assertEventContract(catalog, event({ data: {} }));
    }).toThrow(
      expect.objectContaining({
        name: 'EventContractError',
        issues: [`${TYPE} /data: must have required property 'reason'`],
      }),
    );
  });
});
