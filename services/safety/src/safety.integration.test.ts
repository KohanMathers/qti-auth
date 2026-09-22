import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Bus, connectBus, publishCronTick } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { captureLogs } from '@qtiauth/observability/testing';
import { type RunningService, startService } from '@qtiauth/service-kit';
import { natsUrl, startNats, startPostgres } from '@qtiauth/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Database } from './database.ts';
import { definition } from './service.ts';
import { safetyService } from './start.ts';
import { loadTaxonomy } from './taxonomy.ts';

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let scheduler: Bus;
let configDir: string;

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
  scheduler = await connectBus(sections.bus.parse({ servers: [natsUrl(nats)] }), 'scheduler');
  configDir = await mkdtemp(join(tmpdir(), 'qtiauth-safety-'));
});

afterAll(async () => {
  await scheduler.close();
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
});
