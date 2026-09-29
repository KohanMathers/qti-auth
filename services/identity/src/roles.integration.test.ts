import { type Bus, connectBus, rpcRequest } from '@qtiauth/bus';
import { checkOutboxContract } from '@qtiauth/bus/testing';
import { sections } from '@qtiauth/config';
import { AUDIT_EVENTS, IDENTITY_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { captureLogs } from '@qtiauth/observability/testing';
import {
  ANNOUNCE_SUBJECT,
  definePermissions,
  effectivePermissions,
  hashSessionToken,
  type Identity,
  missingPermissions,
  RESOLVE_SESSION_METHOD,
  RESOLVE_SESSION_SERVICE,
  type RunningService,
  SESSION_TOKEN_HEADER,
  serviceSchema,
  startService,
} from '@qtiauth/service-kit';
import { generateIdentityKey, identityHeaders } from '@qtiauth/service-kit/testing';
import { natsUrl, startNats, startPostgres, startValkey } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { issueAdminSignup } from './admin.ts';
import type { Database } from './database.ts';
import { emailNormalizer } from './email.ts';
import { definition } from './service.ts';
import { identityService } from './start.ts';

const HOST = 'me.example.com';
const key = generateIdentityKey();
const STAFF_ID = '11111111-1111-4111-8111-111111111111';

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let valkey: Awaited<ReturnType<typeof startValkey>>;
let gateway: Bus;
let identity: RunningService<typeof definition, Database>;
const logs = captureLogs();

const anonymous: Partial<Identity> = {
  auth: 'none',
  sub: null,
  sid: null,
  account_state: null,
  age_band: null,
  amr: [],
  acr: null,
};

const staff: Partial<Identity> = {
  auth: 'session',
  sub: STAFF_ID,
  sid: '22222222-2222-4222-8222-222222222222',
  amr: ['email'],
  acr: 'aal2',
  permissions: ['roles.manage'],
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

describe('roles and permissions', () => {
  it('seeds built-in roles and lists permissions from running manifests', async () => {
    const roles = await call('/api/v1/admin/roles');
    expect(roles.status).toBe(200);
    const body = (await roles.json()) as {
      items: {
        slug: string;
        permissions: string[];
        effective: { name: string }[];
        builtin: boolean;
      }[];
    };
    expect(body.items.map((role) => role.slug)).toEqual([
      'admin',
      'game_manager',
      'kb_editor',
      'moderator',
      'support_agent',
    ]);
    const admin = body.items.find((role) => role.slug === 'admin');
    expect(admin?.builtin).toBe(true);
    expect(admin?.permissions).toEqual(['*']);
    expect(admin?.effective.map((item) => item.name).sort()).toEqual(
      [
        'audit.read',
        'filter.manage',
        'filter.read',
        'roles.manage',
        'users.ban',
        'users.edit_dob',
        'users.force_username_reset',
        'users.lock',
        'users.read',
      ].sort(),
    );

    const listed = await call('/api/v1/admin/permissions');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ name: 'roles.manage', service: 'identity', wildcard: true }),
      ]) as unknown,
    });
  });

  it('does not let a role with * cover safety.csea.access', async () => {
    gateway.nc.publish(
      ANNOUNCE_SUBJECT,
      JSON.stringify({
        service: 'safety',
        instance_id: 'safety-test',
        version: '1.0.0',
        started_at: new Date().toISOString(),
        manifest: {
          service: 'safety',
          version: '1.0.0',
          routes: [],
          permissions: [
            { name: 'safety.reports.read', description: 'Reports', wildcard: true },
            { name: 'safety.csea.access', description: 'CSEA cases', wildcard: false },
          ],
        },
      }),
    );

    await vi.waitFor(async () => {
      const listed = (await (await call('/api/v1/admin/permissions')).json()) as {
        items: { name: string; wildcard: boolean }[];
      };
      expect(listed.items.map((item) => item.name)).toEqual(
        expect.arrayContaining(['safety.csea.access', 'safety.reports.read']),
      );
    });

    const roles = (await (await call('/api/v1/admin/roles')).json()) as {
      items: { slug: string; permissions: string[]; effective: { name: string }[] }[];
    };
    const admin = roles.items.find((role) => role.slug === 'admin');
    expect(admin?.effective.map((item) => item.name)).toContain('safety.reports.read');
    expect(admin?.effective.map((item) => item.name)).not.toContain('safety.csea.access');

    const csea = definePermissions({
      'safety.csea.access': { description: 'CSEA cases', wildcard: false },
    });
    expect(missingPermissions(['*'], [csea['safety.csea.access']])).toEqual(['safety.csea.access']);
    expect(effectivePermissions(['*'], Object.values(csea)).map((item) => item.name)).toEqual([]);
  });

  it('creates, edits and deletes custom roles, but not built-ins', async () => {
    const created = await call('/api/v1/admin/roles', {
      method: 'POST',
      body: JSON.stringify({
        slug: 'reviewer',
        name: 'Reviewer',
        description: 'Read reports',
        permissions: ['safety.reports.read'],
      }),
    });
    expect(created.status).toBe(201);
    const role = (await created.json()) as { id: string; slug: string };
    expect(role.slug).toBe('reviewer');

    const patched = await call(`/api/v1/admin/roles/${role.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ permissions: ['filter.read'] }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ permissions: ['filter.read'] });

    const admin = (
      (await (await call('/api/v1/admin/roles')).json()) as {
        items: { id: string; slug: string }[];
      }
    ).items.find((item) => item.slug === 'admin');
    expect(admin).toBeDefined();
    const builtin = await call(`/api/v1/admin/roles/${admin?.id ?? ''}`, { method: 'DELETE' });
    expect(builtin.status).toBe(409);
    expect(await builtin.json()).toMatchObject({ code: 'ROLE_BUILTIN' });

    const deleted = await call(`/api/v1/admin/roles/${role.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
  });

  it('assigns roles so a user holds the role', async () => {
    const userId = '33333333-3333-4333-8333-333333333333';
    await identity.context.db
      .insertInto('users')
      .values({
        id: userId,
        state: 'active',
        email: 'staff-role@example.com',
        email_normalized: 'staff-role@example.com',
        email_verified_at: new Date(),
        date_of_birth: '1990-01-01',
        locale: null,
        public_profile: false,
        leaderboard_visible: false,
        security_notifications: true,
      })
      .execute();
    const adminId = (
      (await (await call('/api/v1/admin/roles')).json()) as {
        items: { id: string; slug: string }[];
      }
    ).items.find((item) => item.slug === 'admin')?.id;
    const assigned = await call(`/api/v1/admin/users/${userId}/roles`, {
      method: 'PUT',
      body: JSON.stringify({ role_ids: [adminId] }),
    });
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toMatchObject({
      items: [expect.objectContaining({ slug: 'admin', permissions: ['*'] })],
    });
  });

  it('issues a one-time admin signup and refuses a second bootstrap', async () => {
    await identity.context.db.deleteFrom('user_roles').execute();
    const normalizeEmail = emailNormalizer(identity.context.config.accounts.email_normalization);
    const issued = await issueAdminSignup(identity.context.db, {
      email: 'first-admin@example.com',
      locale: 'en-GB',
      ttl: 900_000,
      normalizeEmail,
      roles: identity.context.config.roles,
      now: new Date(),
    });
    expect(issued.status).toBe('issued');
    if (issued.status !== 'issued') return;

    const verify = await call('/api/v1/auth/magic-link/verify', {
      method: 'POST',
      as: anonymous,
      body: JSON.stringify({ token: issued.token }),
    });
    expect(verify.status).toBe(200);
    const next = (await verify.json()) as { status: string; signup_token: string };
    expect(next.status).toBe('signup_required');

    const signup = await call('/api/v1/auth/magic-link/signup', {
      method: 'POST',
      as: anonymous,
      body: JSON.stringify({ signup_token: next.signup_token, date_of_birth: '1990-05-01' }),
    });
    expect(signup.status).toBe(201);
    const token = signup.headers.get(SESSION_TOKEN_HEADER) ?? '';
    const resolved = await rpcRequest<{
      session: { permissions: string[]; two_factor_enrolment_required: boolean } | null;
    }>(gateway, RESOLVE_SESSION_SERVICE, RESOLVE_SESSION_METHOD, {
      binding_token_hash: hashSessionToken(token),
      cookie_scope: HOST,
    });
    expect(resolved).toMatchObject({
      status: 'ok',
      data: {
        session: {
          permissions: ['*'],
          two_factor_enrolment_required: true,
        },
      },
    });
    const csea = definePermissions({
      'safety.csea.access': { description: 'CSEA cases', wildcard: false },
    });
    expect(missingPermissions(['*'], [csea['safety.csea.access']])).toEqual(['safety.csea.access']);

    const again = await issueAdminSignup(identity.context.db, {
      email: 'second-admin@example.com',
      locale: 'en-GB',
      ttl: 900_000,
      normalizeEmail,
      roles: identity.context.config.roles,
      now: new Date(),
    });
    expect(again.status).toBe('admin_exists');
  });

  it('refuses the registry without roles.manage', async () => {
    const response = await call('/api/v1/admin/permissions', {
      as: { ...staff, permissions: [] },
    });
    expect(response.status).toBe(403);
  });

  it('writes role events that match their schemas', async () => {
    const events = await checkOutboxContract(identity.context.db, await loadEventCatalog());
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        AUDIT_EVENTS.recorded,
        IDENTITY_EVENTS.userUpdated,
        IDENTITY_EVENTS.userCreated,
        IDENTITY_EVENTS.sessionCreated,
      ]),
    );
  });
});
