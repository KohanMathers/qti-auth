import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Bus, connectBus, publishCronTick } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { captureLogs } from '@qtiauth/observability/testing';
import { type RunningService, startService } from '@qtiauth/service-kit';
import {
  generateIdentityKey,
  identityHeaders,
  serveTestIdentityKeys,
} from '@qtiauth/service-kit/testing';
import { natsUrl, startNats, startPostgres } from '@qtiauth/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadCatalog } from './catalog.ts';
import type { Database } from './database.ts';
import { applyAction } from './moderation.ts';
import { createReport, getReport } from './reports.ts';
import { definition } from './service.ts';
import { safetyService } from './start.ts';
import { loadTaxonomy } from './taxonomy.ts';

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let scheduler: Bus;
let gateway: Bus;
let configDir: string;
const key = generateIdentityKey();

function config() {
  return {
    service: sections.service.parse({}),
    observability: sections.observability.parse({
      logs: { user_id_hash_key: 'safety-integration' },
      metrics: { process_metrics: false },
    }),
    bus: sections.bus.parse({
      servers: [natsUrl(nats)],
      consumers: { retry_delay: '10ms', max_retry_delay: '50ms' },
    }),
    database: sections.database.parse({
      host: postgres.getHost(),
      port: postgres.getPort(),
      name: postgres.getDatabase(),
      roles: { safety: { user: postgres.getUsername(), password: postgres.getPassword() } },
    }),
    migrations: sections.migrations.parse({}),
    branding: sections.branding.parse({}),
    surfaces: sections.surfaces.parse({}),
    features: sections.features.parse({}),
    safety: sections.safety.parse({}),
    retention: sections.retention.parse({}),
    email: sections.email.parse({ provider: 'console' }),
  };
}

async function outboxTypes(safety: RunningService<typeof definition, Database>): Promise<string[]> {
  const { rows } = await sql<{ subject: string }>`select subject from outbox`.execute(
    safety.context.db,
  );
  return rows.map((row) => row.subject);
}

async function outboxEnvelopes(
  safety: RunningService<typeof definition, Database>,
): Promise<string[]> {
  const { rows } = await sql<{ envelope: unknown }>`select envelope from outbox`.execute(
    safety.context.db,
  );
  return rows.map((row) => JSON.stringify(row.envelope));
}

beforeAll(async () => {
  [postgres, nats] = await Promise.all([startPostgres(), startNats()]);
  const bus = sections.bus.parse({ servers: [natsUrl(nats)] });
  scheduler = await connectBus(bus, 'scheduler');
  gateway = await connectBus(bus, 'gateway');
  serveTestIdentityKeys(gateway, key);
  configDir = await mkdtemp(join(tmpdir(), 'qtiauth-safety-'));
});

afterAll(async () => {
  await scheduler.close();
  await gateway.close();
  await Promise.all([postgres.stop(), nats.stop()]);
  await rm(configDir, { recursive: true, force: true });
});

describe('safety service', () => {
  const logs = captureLogs();
  let safety: RunningService<typeof definition, Database>;

  beforeAll(async () => {
    safety = await startService(definition, {
      ...safetyService(),
      config: config(),
      port: 0,
      tracing: false,
      logDestination: logs.destination,
    });
  });

  afterAll(async () => {
    await safety.stop();
  });

  it('serves the taxonomy without needing a session', async () => {
    const response = await fetch(`${safety.url}/api/v1/safety/taxonomy`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { types: { id: string }[] };
    const ids = body.types.map((type) => type.id).sort();
    expect(ids).toContain('csea');
    expect(ids).toContain('hate');
  });

  it('accepts a game intake report, records the snapshot and emits report.created', async () => {
    const taxonomy = loadTaxonomy(config().safety);
    const { createReport } = await import('./reports.ts');
    const targetUserId = '11111111-2222-3333-4444-555555555555';
    const result = await createReport(safety.context.db, taxonomy, {
      typeId: 'hate',
      subtypeId: 'targeted_harassment',
      target: { type: 'user', id: targetUserId },
      source: 'game',
      gameId: 'space-arena',
      clientId: 'game:space-arena',
      snapshot: { content_type: 'text/plain', content: 'You are the worst!' },
      actor: { type: 'service', id: 'game:space-arena' },
      now: new Date(),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('report failed');

    const row = await safety.context.db
      .selectFrom('reports')
      .selectAll()
      .where('id', '=', result.report.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 'open',
      type: 'hate',
      source: 'game',
      game_id: 'space-arena',
      client_id: 'game:space-arena',
      target_user_id: targetUserId,
    });

    const snapshot = await safety.context.db
      .selectFrom('report_snapshots')
      .selectAll()
      .where('report_id', '=', result.report.id)
      .executeTakeFirstOrThrow();
    expect(snapshot.content).toContain('You are the worst!');

    expect(await outboxTypes(safety)).toContain('qtiauth.safety.report.created.v1');
  });

  it('never emits report.created for CSEA-flagged reports', async () => {
    const taxonomy = loadTaxonomy(config().safety);
    const { createReport } = await import('./reports.ts');
    const before = (await outboxTypes(safety)).filter(
      (type) => type === 'qtiauth.safety.report.created.v1',
    ).length;

    const result = await createReport(safety.context.db, taxonomy, {
      typeId: 'csea',
      subtypeId: 'csam',
      target: { type: 'user', id: '22222222-3333-4444-5555-666666666666' },
      source: 'user',
      actor: { type: 'user', id: 'reporter-id' },
      now: new Date(),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('report failed');

    const after = (await outboxTypes(safety)).filter(
      (type) => type === 'qtiauth.safety.report.created.v1',
    ).length;
    expect(after).toBe(before);
    const row = await safety.context.db
      .selectFrom('reports')
      .select(['csea'])
      .where('id', '=', result.report.id)
      .executeTakeFirstOrThrow();
    expect(row.csea).toBe(true);
  });

  it('never puts the reporter contact in the report.created event', async () => {
    const taxonomy = loadTaxonomy(config().safety);
    const { createReport } = await import('./reports.ts');
    const contact = 'reporter@example.com';
    const result = await createReport(safety.context.db, taxonomy, {
      typeId: 'fraud',
      subtypeId: 'phishing',
      target: { type: 'user', id: '33333333-4444-5555-6666-777777777777' },
      source: 'user',
      reporter: { userId: 'user-9', contact, locale: 'en-GB' },
      actor: { type: 'user', id: 'user-9' },
      now: new Date(),
    });
    if (result.status !== 'ok') throw new Error('report failed');
    for (const envelope of await outboxEnvelopes(safety)) {
      expect(envelope).not.toContain(contact);
    }
  });

  it('emits sla_breached on the sweep and marks the report so it does not fire again', async () => {
    const taxonomy = loadTaxonomy(config().safety);
    const { createReport } = await import('./reports.ts');
    const result = await createReport(safety.context.db, taxonomy, {
      typeId: 'terrorism',
      subtypeId: 'propaganda',
      target: { type: 'content', id: 'post-42' },
      source: 'user',
      actor: { type: 'user', id: 'user-42' },
      now: new Date(),
    });
    if (result.status !== 'ok') throw new Error('report failed');
    await safety.context.db
      .updateTable('reports')
      .set({ sla_deadline: new Date(Date.now() - 60_000) })
      .where('id', '=', result.report.id)
      .execute();

    await publishCronTick(scheduler.js, 'safety.sla_sweep', new Date());

    await vi.waitFor(async () => {
      const row = await safety.context.db
        .selectFrom('reports')
        .select(['sla_breach_notified_at'])
        .where('id', '=', result.report.id)
        .executeTakeFirstOrThrow();
      expect(row.sla_breach_notified_at).not.toBeNull();
    });
    expect(await outboxTypes(safety)).toContain('qtiauth.safety.report.sla_breached.v1');

    const firstCount = (await outboxTypes(safety)).filter(
      (type) => type === 'qtiauth.safety.report.sla_breached.v1',
    ).length;
    await publishCronTick(scheduler.js, 'safety.sla_sweep', new Date());
    await new Promise((resolve) => setTimeout(resolve, 200));
    const secondCount = (await outboxTypes(safety)).filter(
      (type) => type === 'qtiauth.safety.report.sla_breached.v1',
    ).length;
    expect(secondCount).toBe(firstCount);
  });

  it('serves the catalog, queue, actions, dismiss, history and appeals', async () => {
    const staffId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const otherStaff = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const targetId = '11111111-2222-3333-4444-555555555555';
    const staff = {
      sub: staffId,
      permissions: ['safety.reports.read', 'safety.actions.apply'],
    };
    const headers = {
      ...identityHeaders(key, 'safety', staff),
      'content-type': 'application/json',
    };
    const catalog = await fetch(`${safety.url}/api/v1/admin/safety/catalog`, { headers });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({
      bans: { require_second_approval: false },
      restrictions: ['chat', 'ugc', 'username_change'],
    });

    const taxonomy = loadTaxonomy(config().safety);
    const opened = await createReport(safety.context.db, taxonomy, {
      typeId: 'hate',
      subtypeId: 'targeted_harassment',
      target: { type: 'user', id: targetId, user_id: targetId },
      source: 'user',
      actor: { type: 'user', id: staffId },
      now: new Date(),
    });
    expect(opened.status).toBe('ok');
    if (opened.status !== 'ok') throw new Error('report failed');

    const queue = await fetch(`${safety.url}/api/v1/admin/safety/reports`, { headers });
    expect(queue.status).toBe(200);
    const queued = (await queue.json()) as { items: { id: string }[] };
    expect(queued.items.some((item) => item.id === opened.report.id)).toBe(true);

    const applied = await fetch(
      `${safety.url}/api/v1/admin/safety/reports/${opened.report.id}/actions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'restrict', rule_id: 'hate', restrictions: ['chat'] }),
      },
    );
    expect(applied.status).toBe(201);
    const action = (await applied.json()) as { id: string; action: string; status: string };
    expect(action).toMatchObject({ action: 'restrict', status: 'applied' });
    expect(await outboxTypes(safety)).toContain('qtiauth.safety.report.actioned.v1');

    const history = await fetch(`${safety.url}/api/v1/admin/safety/users/${targetId}/history`, {
      headers,
    });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      items: [expect.objectContaining({ id: action.id })],
    });

    const appeal = await fetch(`${safety.url}/api/v1/safety/appeals`, {
      method: 'POST',
      headers: {
        ...identityHeaders(key, 'safety', { sub: targetId, account_state: 'active' }),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action_id: action.id, body: 'This was a joke.' }),
    });
    expect(appeal.status).toBe(201);
    const openedAppeal = (await appeal.json()) as { id: string };
    const resolved = await fetch(
      `${safety.url}/api/v1/admin/safety/appeals/${openedAppeal.id}/resolve`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ outcome: 'lifted' }),
      },
    );
    expect(resolved.status).toBe(200);
    expect(await outboxTypes(safety)).toContain('qtiauth.safety.appeal.resolved.v1');

    const toDismiss = await createReport(safety.context.db, taxonomy, {
      typeId: 'fraud',
      subtypeId: 'phishing',
      target: { type: 'user', id: targetId, user_id: targetId },
      source: 'game',
      gameId: 'arena',
      actor: { type: 'service', id: 'game:arena' },
      now: new Date(),
    });
    if (toDismiss.status !== 'ok') throw new Error('report failed');
    const dismissed = await fetch(
      `${safety.url}/api/v1/admin/safety/reports/${toDismiss.report.id}/dismiss`,
      { method: 'POST', headers },
    );
    expect(dismissed.status).toBe(204);

    const pendingReport = await createReport(safety.context.db, taxonomy, {
      typeId: 'hate',
      subtypeId: 'targeted_harassment',
      target: { type: 'user', id: targetId, user_id: targetId },
      source: 'user',
      actor: { type: 'user', id: otherStaff },
      now: new Date(),
    });
    if (pendingReport.status !== 'ok') throw new Error('report failed');
    const pendingRow = await getReport(safety.context.db, pendingReport.report.id);
    expect(pendingRow).toBeDefined();
    if (!pendingRow) throw new Error('report missing');
    const twoPerson = loadCatalog(
      sections.safety.parse({ bans: { require_second_approval: true } }),
    );
    const pending = await applyAction(safety.context.db, twoPerson, pendingRow, {
      reportId: pendingReport.report.id,
      action: 'ban',
      ruleId: 'hate',
      actorId: staffId,
      now: new Date(),
    });
    expect(pending.status).toBe('pending_approval');
    if (pending.status !== 'pending_approval') throw new Error('expected pending');

    const confirm = await fetch(
      `${safety.url}/api/v1/admin/safety/approvals/${pending.approvalId}/confirm`,
      {
        method: 'POST',
        headers: {
          ...identityHeaders(key, 'safety', {
            sub: otherStaff,
            permissions: ['safety.actions.apply'],
          }),
          'content-type': 'application/json',
        },
      },
    );
    expect(confirm.status).toBe(201);
  });
});
