import { type Bus, connectBus } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { captureLogs } from '@qtiauth/observability/testing';
import {
  type Identity,
  type RunningService,
  serviceSchema,
  startService,
} from '@qtiauth/service-kit';
import { generateIdentityKey, identityHeaders } from '@qtiauth/service-kit/testing';
import { natsUrl, startNats, startPostgres, startValkey } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from './database.ts';
import { applyFilter } from './filter.ts';
import { definition } from './service.ts';
import { identityService } from './start.ts';

const HOST = 'me.example.com';
const key = generateIdentityKey();

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let valkey: Awaited<ReturnType<typeof startValkey>>;
let gateway: Bus;
let identity: RunningService<typeof definition, Database>;
const logs = captureLogs();

const staff: Partial<Identity> = {
  auth: 'session',
  sub: '11111111-1111-1111-1111-111111111111',
  sid: '22222222-2222-2222-2222-222222222222',
  amr: ['email'],
  acr: 'aal1',
  permissions: ['filter.read', 'filter.manage'],
};

function call(path: string, init: RequestInit & { as?: Partial<Identity> } = {}) {
  const { as = staff, ...rest } = init;
  return fetch(`${identity.url}${path}`, {
    ...rest,
    headers: {
      ...identityHeaders(key, 'identity', as),
      'x-forwarded-host': HOST,
      ...(rest.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

beforeAll(async () => {
  [postgres, nats, valkey] = await Promise.all([startPostgres(), startNats(), startValkey()]);
  const bus = sections.bus.parse({ servers: [natsUrl(nats)] });
  gateway = await connectBus(bus, 'gateway');
  identity = await startService(definition, {
    ...identityService({ statsInterval: 60_000 }),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    identityKeys: key.keys,
    config: serviceSchema(definition).parse({
      bus: { servers: [natsUrl(nats)] },
      captcha: { after: 1000 },
      database: {
        host: postgres.getHost(),
        port: postgres.getPort(),
        name: postgres.getDatabase(),
        roles: { identity: { user: postgres.getUsername(), password: postgres.getPassword() } },
      },
      observability: {
        logs: { user_id_hash_key: 'integration' },
        metrics: { process_metrics: false },
      },
      surfaces: { account: { hosts: [HOST] } },
      valkey: { host: valkey.getHost(), port: valkey.getPort() },
      security: { encryption_key: Buffer.alloc(32, 9).toString('base64') },
    }),
  });
});

afterAll(async () => {
  await identity.stop();
  await gateway.close();
  await Promise.all([postgres.stop(), nats.stop(), valkey.stop()]);
});

describe('text filter admin', () => {
  it('records blocks and unknowns, and serves them to staff', async () => {
    expect(await applyFilter(identity.context, 'cunt', 'username')).toMatchObject({
      decision: 'block',
    });
    expect(await applyFilter(identity.context, 'harmless-unknown', 'username')).toMatchObject({
      decision: 'allow',
      rule: 'unknown',
    });

    const blocks = await call('/api/v1/admin/filter/blocks');
    expect(blocks.status).toBe(200);
    expect(await blocks.json()).toMatchObject({
      items: [expect.objectContaining({ normalized: 'cunt', decision: 'block' })],
    });

    const unknowns = await call('/api/v1/admin/filter/unknowns');
    expect(unknowns.status).toBe(200);
    expect(await unknowns.json()).toMatchObject({
      items: [expect.objectContaining({ normalized: 'harmless-unknown', rule: 'unknown' })],
    });
  });

  it('fuckfaceIsNotAccepted', async () => {
    const added = await call('/api/v1/admin/filter/blocklist', {
      method: 'POST',
      body: JSON.stringify({ word: 'fuckface' }),
    });
    expect(added.status).toBe(200);
    expect(await applyFilter(identity.context, 'FuckFace', 'username')).toMatchObject({
      decision: 'block',
      matched: 'fuckface',
    });
    const listed = await call('/api/v1/admin/filter/blocklist');
    expect(await listed.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ word: 'fuckface', source: 'admin' }),
      ]) as unknown,
    });
  });

  it('refuses the lists without filter.read', async () => {
    const response = await call('/api/v1/admin/filter/blocks', {
      as: { ...staff, permissions: [] },
    });
    expect(response.status).toBe(403);
  });
});
