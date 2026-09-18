import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import { type Bus, connectBus, createEvent, publishEvent } from '@qtiauth/bus';
import { checkOutboxContract } from '@qtiauth/bus/testing';
import { sections } from '@qtiauth/config';
import { AUDIT_EVENTS, IDENTITY_EVENTS, loadEventCatalog } from '@qtiauth/events';
import { captureLogs } from '@qtiauth/observability/testing';
import { type Identity, type RunningService, startService } from '@qtiauth/service-kit';
import { generateIdentityKey, identityHeaders } from '@qtiauth/service-kit/testing';
import { natsUrl, startNats, startPostgres } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Database } from './database.ts';
import { definition } from './service.ts';
import { verifyWebhookSignature, webhookMessageId } from './sign.ts';
import { notifierService } from './start.ts';
import { freePort } from './testing.ts';

const HOST = 'me.example.com';
const key = generateIdentityKey();
const STAFF_ID = '11111111-1111-4111-8111-111111111111';

interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function listen(port: number, inbox: Received[]): Promise<Server> {
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[name] = value;
      }
      inbox.push({
        url: request.url ?? '',
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.statusCode = 204;
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

const staff: Partial<Identity> = {
  auth: 'session',
  sub: STAFF_ID,
  sid: '22222222-2222-4222-8222-222222222222',
  amr: ['email'],
  acr: 'aal2',
  permissions: ['webhooks.manage'],
};

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let identity: Bus;
let notifier: RunningService<typeof definition, Database>;
const logs = captureLogs();
const inbox: Received[] = [];
let receiver: Server;
let receiverPort: number;

function call(path: string, init: RequestInit & { as?: Partial<Identity> } = {}) {
  const { as = staff, ...rest } = init;
  return fetch(`${notifier.url}${path}`, {
    ...rest,
    headers: {
      ...identityHeaders(key, 'notifier', as),
      'x-forwarded-host': HOST,
      ...(rest.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(rest.headers as Record<string, string> | undefined),
    },
  });
}

beforeAll(async () => {
  [postgres, nats] = await Promise.all([startPostgres(), startNats()]);
  receiverPort = await freePort();
  receiver = await listen(receiverPort, inbox);
  const bus = sections.bus.parse({
    servers: [natsUrl(nats)],
    consumers: { retry_delay: '10ms', max_retry_delay: '50ms' },
  });
  identity = await connectBus(bus, 'identity');
  notifier = await startService(definition, {
    ...notifierService({ webhookPollInterval: 50 }),
    port: 0,
    tracing: false,
    logDestination: logs.destination,
    identityKeys: key.keys,
    config: {
      service: sections.service.parse({}),
      observability: sections.observability.parse({
        logs: { user_id_hash_key: 'integration' },
        metrics: { process_metrics: false },
      }),
      bus,
      database: sections.database.parse({
        host: postgres.getHost(),
        port: postgres.getPort(),
        name: postgres.getDatabase(),
        roles: { notify: { user: postgres.getUsername(), password: postgres.getPassword() } },
      }),
      migrations: sections.migrations.parse({}),
      branding: sections.branding.parse({}),
      surfaces: sections.surfaces.parse({ account: { hosts: [HOST] } }),
      email: sections.email.parse({ provider: 'console' }),
      webhooks: sections.webhooks.parse({
        allow_private_targets: true,
        disable_after_failures: 3,
        retry_delay: '50ms',
        max_retry_delay: '100ms',
        endpoints: {
          seeded: {
            url: `http://127.0.0.1:${String(receiverPort)}/seeded`,
            description: 'Seeded Discord',
            events: ['identity.user.*'],
            format: 'discord',
          },
        },
      }),
      retention: sections.retention.parse({}),
    },
  });
});

afterAll(async () => {
  await notifier.stop();
  await identity.close();
  await new Promise<void>((resolve, reject) => {
    receiver.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await Promise.all([postgres.stop(), nats.stop()]);
});

describe('webhook delivery', () => {
  it('seeds config endpoints and refuses a loopback URL when private targets are off', async () => {
    const listed = await call('/api/v1/admin/webhooks');
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { items: { slug: string; format: string }[] };
    expect(body.items).toEqual([
      expect.objectContaining({ slug: 'seeded', format: 'discord', enabled: true }),
    ]);

    const locked = await startService(definition, {
      ...notifierService(),
      port: 0,
      tracing: false,
      identityKeys: key.keys,
      config: {
        ...notifier.context.config,
        webhooks: sections.webhooks.parse({
          allow_private_targets: false,
          endpoints: {
            bad: {
              url: 'http://127.0.0.1/hook',
              description: 'Loopback',
              events: ['identity.user.banned'],
            },
          },
        }),
      },
    }).then(
      (service) => {
        void service.stop();
        return null;
      },
      (error: unknown) => error,
    );
    expect(locked).toBeInstanceOf(Error);
    expect((locked as Error).message).toMatch(/127\.0\.0\.1/);
  });

  it('signs standard webhooks so an off-the-shelf verifier accepts them', async () => {
    const created = await call('/api/v1/admin/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        url: `http://127.0.0.1:${String(receiverPort)}/standard`,
        description: 'Standard receiver',
        events: ['identity.user.banned'],
        format: 'standard',
      }),
    });
    expect(created.status).toBe(201);
    const endpoint = (await created.json()) as { id: string; secret: string; secret_hint: string };
    expect(endpoint.secret.startsWith('whsec_')).toBe(true);
    expect(endpoint.secret_hint).toBe(endpoint.secret.slice(-4));

    const events = await checkOutboxContract(notifier.context.db, await loadEventCatalog());
    expect(events.map((event) => event.type)).toContain(AUDIT_EVENTS.recorded);

    inbox.length = 0;
    await publishEvent(
      identity.js,
      createEvent({
        type: IDENTITY_EVENTS.userBanned,
        actor: { type: 'user', id: STAFF_ID },
        subject: { type: 'user', id: '0199a0e0-0000-7000-8000-00000000beef' },
        data: { reason: 'spam' },
      }),
    );

    await vi.waitFor(() => {
      expect(inbox.some((item) => item.url === '/standard')).toBe(true);
    });
    const received = inbox.find((item) => item.url === '/standard');
    expect(received).toBeDefined();
    const payload = JSON.parse(received?.body ?? '{}') as {
      type: string;
      data: { reason: string; content?: string };
      admin_url: string;
    };
    expect(payload.type).toBe('identity.user.banned');
    expect(payload.data).toEqual({ reason: 'spam' });
    expect(payload.admin_url).toContain('/admin/users/');

    const id = received?.headers['webhook-id'] ?? '';
    const timestamp = Number(received?.headers['webhook-timestamp']);
    const signature = received?.headers['webhook-signature'] ?? '';
    expect(id.startsWith('msg_')).toBe(true);
    expect(
      verifyWebhookSignature(endpoint.secret, id, timestamp, received?.body ?? '', signature),
    ).toBe(true);
    const keyBytes = Buffer.from(endpoint.secret.slice('whsec_'.length), 'base64');
    const expected = createHmac('sha256', keyBytes)
      .update(`${id}.${String(timestamp)}.${received?.body ?? ''}`)
      .digest('base64');
    expect(signature.split(' ')).toContain(`v1,${expected}`);
    expect(webhookMessageId(endpoint.id).startsWith('msg_')).toBe(true);

    const discord = inbox.find((item) => item.url === '/seeded');
    expect(discord).toBeDefined();
    const embed = JSON.parse(discord?.body ?? '{}') as { embeds: { title: string }[] };
    expect(embed.embeds[0]?.title).toContain('identity.user.banned');
  });

  it('sends a Discord test event and records the delivery', async () => {
    const listed = (await (await call('/api/v1/admin/webhooks')).json()) as {
      items: { id: string; slug: string | null }[];
    };
    const seeded = listed.items.find((item) => item.slug === 'seeded');
    expect(seeded).toBeDefined();
    inbox.length = 0;
    const tested = await call(`/api/v1/admin/webhooks/${seeded?.id ?? ''}/test`, {
      method: 'POST',
    });
    expect(tested.status).toBe(202);
    const { delivery_id: deliveryId } = (await tested.json()) as { delivery_id: string };

    await vi.waitFor(async () => {
      const page = await call(`/api/v1/admin/webhooks/${seeded?.id ?? ''}/deliveries`);
      const body = (await page.json()) as {
        items: { id: string; status: string; trigger: string }[];
      };
      expect(body.items.some((item) => item.id === deliveryId && item.status === 'sent')).toBe(
        true,
      );
    });
    expect(
      inbox.some((item) => {
        const body = JSON.parse(item.body) as { embeds?: { title?: string }[] };
        return body.embeds?.[0]?.title?.includes('webhook.test') === true;
      }),
    ).toBe(true);
  });
});
