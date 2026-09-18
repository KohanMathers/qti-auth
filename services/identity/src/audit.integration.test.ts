import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Bus, connectBus } from '@qtiauth/bus';
import { type CliIo, run } from '@qtiauth/cli';
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
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { auditVerify } from './audit-verify.ts';
import { verifyAuditLog } from './audit.ts';
import type { Database } from './database.ts';
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
let configPath: string;
const logs = captureLogs();

const staff: Partial<Identity> = {
  auth: 'session',
  sub: STAFF_ID,
  sid: '22222222-2222-4222-8222-222222222222',
  amr: ['email'],
  acr: 'aal2',
  permissions: ['roles.manage', 'audit.read'],
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

async function qtiauth(argv: string[]) {
  const out = { stdout: '', stderr: '' };
  const io: CliIo = {
    stdout: (text) => {
      out.stdout += text;
    },
    stderr: (text) => {
      out.stderr += text;
    },
    env: {},
  };
  return { code: await run(argv, io, { 'audit verify': auditVerify }), ...out };
}

beforeAll(async () => {
  [postgres, nats, valkey] = await Promise.all([startPostgres(), startNats(), startValkey()]);
  const dir = await mkdtemp(join(tmpdir(), 'qtiauth-audit-'));
  configPath = join(dir, 'qtiauth.yaml');
  await writeFile(
    configPath,
    [
      'database:',
      `  host: ${postgres.getHost()}`,
      `  port: ${String(postgres.getPort())}`,
      `  name: ${postgres.getDatabase()}`,
      '  roles:',
      `    identity: { user: ${postgres.getUsername()}, password: ${postgres.getPassword()} }`,
      'observability:',
      '  logs: { user_id_hash_key: integration }',
      '  metrics: { process_metrics: false }',
      'surfaces:',
      `  account: { hosts: [${HOST}] }`,
      'valkey:',
      `  host: ${valkey.getHost()}`,
      `  port: ${String(valkey.getPort())}`,
      'security:',
      `  encryption_key: ${Buffer.alloc(32, 9).toString('base64')}`,
      '',
    ].join('\n'),
  );
  gateway = await connectBus(sections.bus.parse({ servers: [natsUrl(nats)] }), 'gateway');
  identity = await startService(definition, {
    ...identityService({ statsInterval: 60_000 }),
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

describe('audit log', () => {
  it('stores published records, filters them, and fails verify after a direct edit', async () => {
    const created = await call('/api/v1/admin/roles', {
      method: 'POST',
      body: JSON.stringify({
        slug: 'audit_viewer',
        name: 'Audit viewer',
        description: 'Reads the audit log.',
        permissions: ['audit.read'],
      }),
    });
    expect(created.status).toBe(201);
    const role = (await created.json()) as { id: string };

    const row = await vi.waitFor(
      async () => {
        const listed = await call(`/api/v1/admin/audit?action=role.created&target_id=${role.id}`);
        expect(listed.status).toBe(200);
        const body = (await listed.json()) as {
          items: {
            seq: number;
            event_id: string;
            action: string;
            target_id: string;
            actor_id: string;
          }[];
        };
        const first = body.items[0];
        if (first === undefined) {
          throw new Error('audit row not stored yet');
        }
        return first;
      },
      { timeout: 10_000 },
    );
    expect(row).toMatchObject({
      action: 'role.created',
      target_id: role.id,
      actor_id: STAFF_ID,
    });

    const filtered = await call(
      `/api/v1/admin/audit?actor_id=${STAFF_ID}&target_type=role&from=2020-01-01T00:00:00.000Z`,
    );
    expect(filtered.status).toBe(200);
    expect(((await filtered.json()) as { items: { action: string }[] }).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'role.created' })]),
    );

    expect((await call('/api/v1/admin/audit', { as: { ...staff, permissions: [] } })).status).toBe(
      403,
    );

    const intact = await qtiauth(['audit', 'verify', '--config', configPath]);
    expect(intact).toMatchObject({ code: 0 });
    expect(intact.stdout).toContain('Audit log is intact');

    await sql`update audit_log set action = 'tampered' where seq = ${row.seq}`.execute(
      identity.context.db,
    );
    const broken = await verifyAuditLog(identity.context.db);
    expect(broken).toEqual({ ok: false, seq: row.seq, event_id: row.event_id });

    const verified = await qtiauth(['audit', 'verify', '--config', configPath]);
    expect(verified.code).toBe(1);
    expect(verified.stderr).toContain(`seq=${String(row.seq)}`);
    expect(verified.stderr).toContain(row.event_id);
  });
});
