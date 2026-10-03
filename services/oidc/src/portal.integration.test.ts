import { type Bus, connectBus, rpcRequest } from '@qtiauth/bus';
import { checkOutboxContract } from '@qtiauth/bus/testing';
import { sections } from '@qtiauth/config';
import { AUDIT_EVENTS, loadEventCatalog, OIDC_EVENTS } from '@qtiauth/events';
import { captureLogs } from '@qtiauth/observability/testing';
import {
  CHECK_TEXT_METHOD,
  CHECK_TEXT_SERVICE,
  EXPORT_USER_METHOD,
  type Identity,
  type RunningService,
  serviceSchema,
  startService,
  type UserExport,
} from '@qtiauth/service-kit';
import { generateIdentityKey, identityHeaders } from '@qtiauth/service-kit/testing';
import { natsUrl, startNats, startPostgres, startValkey } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database as IdentityDatabase } from '../../identity/src/database.ts';
import { definition as identityDefinition } from '../../identity/src/service.ts';
import { identityService } from '../../identity/src/start.ts';
import type { Database } from './database.ts';
import { definition } from './service.ts';
import { oidcService } from './start.ts';

const HOST = 'me.example.com';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const key = generateIdentityKey();

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let valkey: Awaited<ReturnType<typeof startValkey>>;
let gateway: Bus;
let identity: RunningService<typeof identityDefinition, IdentityDatabase>;
let oidc: RunningService<typeof definition, Database>;
const logs = captureLogs();

const owner: Partial<Identity> = {
  auth: 'session',
  sub: USER_ID,
  sid: '33333333-3333-4333-8333-333333333333',
  amr: ['email'],
  acr: 'aal2',
  age_band: 'adult',
};

const staff: Partial<Identity> = {
  ...owner,
  sub: STAFF_ID,
  permissions: ['oidc.clients.verify', 'oidc.clients.suspend'],
};

function call(path: string, init: RequestInit & { as?: Partial<Identity> } = {}) {
  const { as = owner, ...rest } = init;
  return fetch(`${oidc.url}${path}`, {
    ...rest,
    headers: {
      ...identityHeaders(key, 'oidc', as),
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
  const observability = {
    logs: { user_id_hash_key: 'integration' },
    metrics: { process_metrics: false },
  };
  identity = await startService(identityDefinition, {
    ...identityService({ statsInterval: 60_000 }),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    identityKeys: key.keys,
    config: serviceSchema(identityDefinition).parse({
      bus: { servers: [natsUrl(nats)] },
      database: {
        host: postgres.getHost(),
        port: postgres.getPort(),
        name: postgres.getDatabase(),
        roles: { identity: { user: postgres.getUsername(), password: postgres.getPassword() } },
      },
      observability,
      surfaces: { account: { hosts: [HOST] } },
      valkey: { host: valkey.getHost(), port: valkey.getPort() },
      security: { encryption_key: Buffer.alloc(32, 9).toString('base64') },
    }),
  });
  oidc = await startService(definition, {
    ...oidcService(),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    identityKeys: key.keys,
    config: serviceSchema(definition).parse({
      bus: { servers: [natsUrl(nats)] },
      database: {
        host: postgres.getHost(),
        port: postgres.getPort(),
        name: postgres.getDatabase(),
        roles: { oidc: { user: postgres.getUsername(), password: postgres.getPassword() } },
      },
      observability,
      surfaces: { account: { hosts: [HOST] } },
      branding: { product_name: 'Example Account' },
      oidc: {
        issuer: 'http://localhost:8000',
        signing: { encryption_key: Buffer.alloc(32, 5).toString('base64') },
        developer_portal: { max_clients_per_user: 2 },
      },
    }),
  });
});

afterAll(async () => {
  await oidc.stop();
  await identity.stop();
  await gateway.close();
  await Promise.all([postgres.stop(), nats.stop(), valkey.stop()]);
});

describe('developer portal', () => {
  it('creates, lists, edits, regenerates a secret, verifies, suspends and deletes a client', async () => {
    const created = await call('/api/v1/oauth/clients', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Studio App',
        description: 'A third-party tool',
        type: 'confidential',
        redirect_uris: ['https://app.example.com/callback'],
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      client_id: string;
      secret: string | null;
      verified: boolean;
      type: string;
    };
    expect(body.type).toBe('confidential');
    expect(body.verified).toBe(false);
    expect(body.secret).toEqual(expect.any(String));
    const clientId = body.client_id;
    const secret = body.secret ?? '';

    const listed = await call('/api/v1/oauth/clients');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      items: [expect.objectContaining({ client_id: clientId, name: 'Studio App' })],
    });

    const patched = await call(`/api/v1/oauth/clients/${clientId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Studio App 2' }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ name: 'Studio App 2' });

    const rotated = await call(`/api/v1/oauth/clients/${clientId}/secret`, { method: 'POST' });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as { secret: string };
    expect(rotatedBody.secret).not.toBe(secret);

    const unverified = await call('/api/v1/admin/oauth/clients?verified=false', { as: staff });
    expect(unverified.status).toBe(200);
    expect(await unverified.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ client_id: clientId, verified: false }),
      ]) as unknown,
    });

    const verified = await call(`/api/v1/admin/oauth/clients/${clientId}/verify`, {
      method: 'POST',
      as: staff,
    });
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ verified: true });
    const reviewed = await call('/api/v1/admin/oauth/clients?verified=false', { as: staff });
    const pending = (await reviewed.json()) as { items: { client_id: string }[] };
    expect(pending.items.map((item) => item.client_id)).not.toContain(clientId);

    const row = await oidc.context.db
      .selectFrom('clients')
      .select('id')
      .where('client_id', '=', clientId)
      .executeTakeFirstOrThrow();
    await oidc.context.db
      .insertInto('access_tokens')
      .values({
        id: '0199a0e0-0000-7000-8000-00000000aa01',
        client_id: row.id,
        user_id: USER_ID,
        session_id: owner.sid ?? null,
        scopes: ['openid'],
        amr: ['email'],
        acr: 'aal2',
        expires_at: new Date(Date.now() + 60_000),
        revoked_at: null,
        refresh_id: null,
        created_at: new Date(),
      })
      .execute();

    const suspended = await call(`/api/v1/admin/oauth/clients/${clientId}/suspend`, {
      method: 'POST',
      as: staff,
    });
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({ suspended: true });
    const token = await oidc.context.db
      .selectFrom('access_tokens')
      .select('revoked_at')
      .where('id', '=', '0199a0e0-0000-7000-8000-00000000aa01')
      .executeTakeFirst();
    expect(token?.revoked_at).not.toBeNull();

    const events = await checkOutboxContract(oidc.context.db, await loadEventCatalog());
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([OIDC_EVENTS.clientCreated, AUDIT_EVENTS.recorded]),
    );

    const exported = await rpcRequest<UserExport>(gateway, 'oidc', EXPORT_USER_METHOD, {
      user_id: USER_ID,
    });
    expect(exported).toMatchObject({
      status: 'ok',
      data: {
        data: {
          clients: [expect.objectContaining({ client_id: clientId, name: 'Studio App 2' })],
        },
      },
    });

    const deleted = await call(`/api/v1/oauth/clients/${clientId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
  });

  it('refuses child accounts, brand names, filtered text and the per-user limit', async () => {
    const child = await call('/api/v1/oauth/clients', {
      method: 'POST',
      as: { ...owner, age_band: 'under_13' },
      body: JSON.stringify({ name: 'Kid App', type: 'public' }),
    });
    expect(child.status).toBe(403);
    expect(await child.json()).toMatchObject({ code: 'CLIENT_CHILD_ACCOUNT' });

    const branded = await call('/api/v1/oauth/clients', {
      method: 'POST',
      body: JSON.stringify({ name: 'Example Account Games', type: 'public' }),
    });
    expect(branded.status).toBe(400);
    expect(await branded.json()).toMatchObject({ code: 'CLIENT_NAME_REJECTED' });

    const filtered = await call('/api/v1/oauth/clients', {
      method: 'POST',
      body: JSON.stringify({ name: 'cunt', type: 'public' }),
    });
    expect(filtered.status).toBe(400);
    expect(await filtered.json()).toMatchObject({ code: 'CLIENT_NAME_REJECTED' });

    const first = await call('/api/v1/oauth/clients', {
      method: 'POST',
      body: JSON.stringify({ name: 'Limit One', type: 'public' }),
    });
    expect(first.status).toBe(201);
    const second = await call('/api/v1/oauth/clients', {
      method: 'POST',
      body: JSON.stringify({ name: 'Limit Two', type: 'public' }),
    });
    expect(second.status).toBe(201);
    const third = await call('/api/v1/oauth/clients', {
      method: 'POST',
      body: JSON.stringify({ name: 'Limit Three', type: 'public' }),
    });
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ code: 'CLIENT_LIMIT_REACHED' });
  });

  it('answers check_text over RPC the way the portal uses it', async () => {
    const blocked = await rpcRequest<{ decision: string }>(
      gateway,
      CHECK_TEXT_SERVICE,
      CHECK_TEXT_METHOD,
      { text: 'cunt', context: 'oidc_client_name' },
    );
    expect(blocked).toMatchObject({ status: 'ok', data: { decision: 'block' } });
    const allowed = await rpcRequest<{ decision: string }>(
      gateway,
      CHECK_TEXT_SERVICE,
      CHECK_TEXT_METHOD,
      { text: 'Studio App', context: 'oidc_client_name' },
    );
    expect(allowed).toMatchObject({ status: 'ok', data: { decision: 'allow' } });
  });
});
