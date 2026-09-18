import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Bus,
  connectBus,
  createEvent,
  publishCronTick,
  publishEvent,
  rpcRequest,
} from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { queueEmail } from '@qtiauth/email';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import {
  EXPORT_USER_METHOD,
  type RunningService,
  startService,
  USER_DELETED_EVENT,
  type UserExport,
} from '@qtiauth/service-kit';
import { natsUrl, startNats, startPostgres } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { consoleProvider } from './console.ts';
import type { Database } from './deliveries.ts';
import { definition } from './service.ts';
import { type NotifierOptions, notifierService } from './start.ts';
import { TemplateError } from './templates.ts';
import { freePort, startTestSmtpServer } from './testing.ts';

const TOKEN = 'integration-magic-token';
const LINK = `https://me.example.com/magic-link?token=${TOKEN}`;
const USER_ID = '0199a0e0-0000-7000-8000-00000000beef';
const RECIPIENT = 'someone@example.com';

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let identity: Bus;
let configDir: string;

function config(email: Record<string, unknown>) {
  return {
    service: sections.service.parse({}),
    observability: sections.observability.parse({
      logs: { user_id_hash_key: 'integration' },
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
      roles: { notify: { user: postgres.getUsername(), password: postgres.getPassword() } },
    }),
    migrations: sections.migrations.parse({}),
    branding: sections.branding.parse({}),
    email: sections.email.parse(email),
    retention: sections.retention.parse({}),
  };
}

function startNotifier(
  email: Record<string, unknown>,
  logs: ReturnType<typeof captureLogs>,
  options: NotifierOptions = {},
): Promise<RunningService<typeof definition, Database>> {
  return startService(definition, {
    ...notifierService({ configDir, ...options }),
    config: config(email),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
  });
}

function magicLink(address = RECIPIENT) {
  return queueEmail(identity, {
    template: 'magic_link',
    to: { address },
    locale: 'en-GB',
    userId: USER_ID,
    variables: { link: LINK, expires_in_minutes: 15 },
  });
}

function delivery(service: RunningService<typeof definition, Database>, id: string) {
  return service.context.db
    .selectFrom('email_deliveries')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
}

beforeAll(async () => {
  [postgres, nats] = await Promise.all([startPostgres(), startNats()]);
  identity = await connectBus(sections.bus.parse({ servers: [natsUrl(nats)] }), 'identity');
  configDir = await mkdtemp(join(tmpdir(), 'qtiauth-notifier-'));
});

afterAll(async () => {
  await identity.close();
  await Promise.all([postgres.stop(), nats.stop()]);
  await rm(configDir, { recursive: true, force: true });
});

describe('notifier with the console provider', () => {
  const logs = captureLogs();
  let printed = '';
  let notifier: RunningService<typeof definition, Database>;

  beforeAll(async () => {
    notifier = await startNotifier({ provider: 'console' }, logs, {
      provider: () => consoleProvider((text) => (printed += text)),
    });
  });

  afterAll(async () => {
    await notifier.stop();
  });

  it('sends queued email and records the delivery', async () => {
    const job = await magicLink();

    await vi.waitFor(async () => {
      expect((await delivery(notifier, job.delivery_id))?.status).toBe('sent');
    });
    expect(printed).toContain(`Email ${job.delivery_id}`);
    expect(printed).toContain(LINK);
    expect(await delivery(notifier, job.delivery_id)).toMatchObject({
      template: 'magic_link',
      locale: 'en-GB',
      category: 'auth',
      priority: 'high',
      recipient: RECIPIENT,
      user_id: USER_ID,
      attempts: 1,
      provider: 'console',
      provider_message_id: `console-${job.delivery_id}`,
      last_error: null,
    });

    const metrics = await (await fetch(`${notifier.url}/metrics`)).text();
    expect(metrics).toContain(
      'qtiauth_email_deliveries_total{provider="console",template="magic_link",status="sent",service="notifier"} 1',
    );
    expect(await (await fetch(`${notifier.url}/readyz`)).json()).toMatchObject({
      status: 'ok',
      checks: { nats: { status: 'ok' }, database: { status: 'ok' } },
    });
  });

  it('exports and erases a user’s delivery log', async () => {
    const exported = await rpcRequest<UserExport>(identity, 'notifier', EXPORT_USER_METHOD, {
      user_id: USER_ID,
    });
    expect(exported).toMatchObject({
      status: 'ok',
      data: {
        service: 'notifier',
        data: {
          email_deliveries: [
            expect.objectContaining({ template: 'magic_link', recipient: RECIPIENT }),
          ],
        },
      },
    });

    await publishEvent(
      identity.js,
      createEvent({
        type: USER_DELETED_EVENT,
        actor: { type: 'system', id: 'identity' },
        subject: { type: 'user', id: USER_ID },
        data: { held: false },
      }),
    );

    await vi.waitFor(async () => {
      const rows = await notifier.context.db
        .selectFrom('email_deliveries')
        .select('id')
        .where('user_id', '=', USER_ID)
        .execute();
      expect(rows).toEqual([]);
    });
  });

  it('deletes delivery log entries older than retention.delivery_logs on retention.sweep', async () => {
    const recent = await magicLink();
    await vi.waitFor(async () => {
      expect((await delivery(notifier, recent.delivery_id))?.status).toBe('sent');
    });
    const old = await magicLink();
    await vi.waitFor(async () => {
      expect((await delivery(notifier, old.delivery_id))?.status).toBe('sent');
    });
    await notifier.context.db
      .updateTable('email_deliveries')
      .set({ created_at: new Date(Date.now() - 31 * 86_400_000) })
      .where('id', '=', old.delivery_id)
      .execute();

    await publishCronTick(identity.js, 'retention.sweep', new Date());

    await vi.waitFor(async () => {
      expect(await delivery(notifier, old.delivery_id)).toBeUndefined();
    });
    expect(await delivery(notifier, recent.delivery_id)).toBeDefined();
  });

  it('keeps email bodies, links and addresses out of the logs', () => {
    assertLogsScrubbed(logs.lines, [TOKEN, RECIPIENT, USER_ID, postgres.getPassword()]);
  });
});

describe('notifier with a dead SMTP server', () => {
  it('delays mail without failing the request that queued it, and sends it once the server is back', async () => {
    const logs = captureLogs();
    const port = await freePort();
    const notifier = await startNotifier(
      {
        provider: 'smtp',
        smtp: { host: '127.0.0.1', port, security: 'none', connect_timeout: '500ms' },
        queue: { max_attempts: 100, retry_delay: '100ms', max_retry_delay: '200ms' },
      },
      logs,
    );
    const smtp: { stop: () => Promise<void> }[] = [];
    try {
      const started = performance.now();
      const job = await magicLink('late@example.com');
      expect(performance.now() - started).toBeLessThan(1_000);

      await vi.waitFor(
        async () => {
          const row = await delivery(notifier, job.delivery_id);
          expect(row?.status).toBe('retrying');
          expect(row?.last_error).toMatch(/ECONNREFUSED/);
          expect(row?.attempts).toBeGreaterThanOrEqual(2);
        },
        { timeout: 10_000, interval: 100 },
      );

      const server = await startTestSmtpServer({ port });
      smtp.push(server);

      await vi.waitFor(
        async () => {
          expect((await delivery(notifier, job.delivery_id))?.status).toBe('sent');
        },
        { timeout: 10_000, interval: 100 },
      );
      expect(server.received).toHaveLength(1);
      expect(server.received[0]).toMatchObject({
        from: 'auth@example.com',
        to: ['late@example.com'],
        subject: 'Your sign-in link for Example Account',
      });
      expect(server.received[0]?.text).toContain(LINK);
      assertLogsScrubbed(logs.lines, [TOKEN, 'late@example.com']);
    } finally {
      await notifier.stop();
      await Promise.all(smtp.map((server) => server.stop()));
    }
  });
});

describe('notifier startup', () => {
  it('refuses to start when a template uses a variable it is not given', async () => {
    const dir = join(configDir, 'broken');
    await mkdir(join(dir, 'templates/email/en-GB'), { recursive: true });
    await writeFile(join(dir, 'templates/email/en-GB/magic_link.txt'), 'Your code is {{ code }}\n');
    const logs = captureLogs();

    await expect(
      startNotifier({ provider: 'console' }, logs, { configDir: dir }),
    ).rejects.toBeInstanceOf(TemplateError);
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ level: 'fatal', message: 'service failed to start' }),
    );
  });
});
