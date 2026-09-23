import {
  type Bus,
  connectBus,
  createEvent,
  publishCronTick,
  publishEvent,
  rpcRequest,
  serveRpc,
} from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { SUPPORT_EVENTS } from '@qtiauth/events';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import {
  EXPORT_USER_METHOD,
  NOTIFICATION_ALLOWED_METHOD,
  type RunningService,
  STAFF_ALERT_RECIPIENTS_METHOD,
  startService,
  USER_CLAIMS_METHOD,
  USER_DELETED_EVENT,
} from '@qtiauth/service-kit';
import {
  generateIdentityKey,
  identityHeaders,
  serveTestIdentityKeys,
} from '@qtiauth/service-kit/testing';
import { natsUrl, startNats, startPostgres } from '@qtiauth/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type CapturedEmails, captureEmails } from '../../identity/src/testing.ts';
import type { Database } from './database.ts';
import { definition } from './service.ts';
import { AUTO_CLOSE_JOB, supportService } from './start.ts';
import { CREATE_APPEAL_METHOD, USER_TICKETS_METHOD } from './tickets.ts';

let postgres: Awaited<ReturnType<typeof startPostgres>>;
let nats: Awaited<ReturnType<typeof startNats>>;
let scheduler: Bus;
let gateway: Bus;
let identity: Bus;
let notifier: Bus;
let emails: CapturedEmails;
const key = generateIdentityKey();
const BODY_MARKER = 'ticket-body-plaintext-7c1e';
const STAFF_ALERT_EMAIL = 'staff-alerts@example.com';
const STAFF_ALERT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function config() {
  return {
    service: sections.service.parse({}),
    observability: sections.observability.parse({
      logs: { user_id_hash_key: 'support-integration' },
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
      roles: { support: { user: postgres.getUsername(), password: postgres.getPassword() } },
    }),
    migrations: sections.migrations.parse({}),
    branding: sections.branding.parse({}),
    surfaces: sections.surfaces.parse({
      account: { hosts: ['account.example.com'] },
      support: { hosts: ['account.example.com'], base_path: '/support' },
    }),
    features: sections.features.parse({}),
    support: sections.support.parse({}),
    retention: sections.retention.parse({}),
    email: sections.email.parse({ provider: 'console' }),
  };
}

async function outboxTypes(
  support: RunningService<typeof definition, Database>,
): Promise<string[]> {
  const { rows } = await sql<{ subject: string }>`select subject from outbox`.execute(
    support.context.db,
  );
  return rows.map((row) => row.subject);
}

async function outboxEnvelopes(
  support: RunningService<typeof definition, Database>,
): Promise<string[]> {
  const { rows } = await sql<{ envelope: unknown }>`select envelope from outbox`.execute(
    support.context.db,
  );
  return rows.map((row) => JSON.stringify(row.envelope));
}

function jsonHeaders(overrides: Parameters<typeof identityHeaders>[2] = {}) {
  return {
    ...identityHeaders(key, 'support', overrides),
    'content-type': 'application/json',
  };
}

function userEmail(userId: string): string {
  return `${userId.slice(0, 8)}@example.com`;
}

beforeAll(async () => {
  [postgres, nats] = await Promise.all([startPostgres(), startNats()]);
  const bus = sections.bus.parse({ servers: [natsUrl(nats)] });
  scheduler = await connectBus(bus, 'scheduler');
  gateway = await connectBus(bus, 'gateway');
  identity = await connectBus(bus, 'identity');
  notifier = await connectBus(bus, 'notifier');
  serveTestIdentityKeys(gateway, key);
  serveRpc(identity, {
    method: USER_CLAIMS_METHOD,
    handler: (request) => {
      const userId = (request as { user_id: string }).user_id;
      return Promise.resolve({
        user: {
          id: userId,
          email: userEmail(userId),
          email_verified: true,
          username: null,
          username_updated_at: null,
          account_state: 'active' as const,
          age_band: 'adult' as const,
          age_assurance_strength: null,
          has_guardians: false,
          parental_controls: null,
          restrictions: [],
        },
      });
    },
    onError: () => undefined,
  });
  serveRpc(identity, {
    method: NOTIFICATION_ALLOWED_METHOD,
    handler: () => Promise.resolve({ allowed: true }),
    onError: () => undefined,
  });
  serveRpc(identity, {
    method: STAFF_ALERT_RECIPIENTS_METHOD,
    handler: () =>
      Promise.resolve({
        recipients: [{ user_id: STAFF_ALERT_ID, email: STAFF_ALERT_EMAIL, locale: 'en-GB' }],
      }),
    onError: () => undefined,
  });
  emails = await captureEmails(notifier);
});

afterAll(async () => {
  await emails.stop();
  await scheduler.close();
  await gateway.close();
  await identity.close();
  await notifier.close();
  await Promise.all([postgres.stop(), nats.stop()]);
});

describe('support service', () => {
  const logs = captureLogs();
  let support: RunningService<typeof definition, Database>;

  beforeAll(async () => {
    support = await startService(definition, {
      ...supportService(),
      config: config(),
      port: 0,
      tracing: false,
      logDestination: logs.destination,
    });
  });

  afterAll(async () => {
    await support.stop();
  });

  it('creates sequential tickets, lists them, replies, closes, reopens and rates', async () => {
    const userId = '11111111-2222-3333-4444-555555555555';
    const headers = jsonHeaders({ sub: userId });
    const first = await fetch(`${support.url}/api/v1/support/tickets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        category_id: 'account',
        subject: 'Cannot sign in',
        body: BODY_MARKER,
      }),
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string; number: number; status: string };
    expect(created.number).toBe(1);
    expect(created.status).toBe('open');
    const staffMail = await emails.nextJob(STAFF_ALERT_EMAIL, 'ticket_opened_staff');
    expect(staffMail.variables).toMatchObject({ number: 1, category: 'Account' });
    expect(JSON.stringify(staffMail)).not.toContain(BODY_MARKER);

    const second = await fetch(`${support.url}/api/v1/support/tickets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        category_id: 'technical',
        subject: 'Crash on launch',
        body: 'It exits.',
      }),
    });
    expect(second.status).toBe(201);
    expect(((await second.json()) as { number: number }).number).toBe(2);

    const listed = await fetch(`${support.url}/api/v1/support/tickets`, { headers });
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { items: { id: string }[] };
    expect(page.items.some((item) => item.id === created.id)).toBe(true);

    const staffId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const staff = jsonHeaders({ sub: staffId, permissions: ['support.tickets.staff'] });
    const assigned = await fetch(`${support.url}/api/v1/admin/support/tickets/${created.id}`, {
      method: 'PATCH',
      headers: staff,
      body: JSON.stringify({ assigned_to: staffId, priority: 'high' }),
    });
    expect(assigned.status).toBe(200);

    const noted = await fetch(`${support.url}/api/v1/admin/support/tickets/${created.id}/notes`, {
      method: 'POST',
      headers: staff,
      body: JSON.stringify({ body: 'Looking into this now.' }),
    });
    expect(noted.status).toBe(200);

    const replied = await fetch(
      `${support.url}/api/v1/admin/support/tickets/${created.id}/replies`,
      {
        method: 'POST',
        headers: staff,
        body: JSON.stringify({ body: 'Please try resetting your password.' }),
      },
    );
    expect(replied.status).toBe(200);
    expect(((await replied.json()) as { status: string }).status).toBe('pending');
    const replyMail = await emails.nextJob(userEmail(userId), 'ticket_reply');
    expect(replyMail.variables).toMatchObject({ number: 1 });

    const userView = await fetch(`${support.url}/api/v1/support/tickets/${created.id}`, {
      headers,
    });
    const viewed = (await userView.json()) as {
      status: string;
      messages: { staff: boolean; body: string }[];
      notes?: unknown;
    };
    expect(viewed.status).toBe('pending');
    expect(viewed.messages.some((message) => message.body === BODY_MARKER)).toBe(true);
    expect(viewed.notes).toBeUndefined();

    const userReply = await fetch(`${support.url}/api/v1/support/tickets/${created.id}/replies`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: 'That worked, thanks.' }),
    });
    expect(userReply.status).toBe(200);
    expect(((await userReply.json()) as { status: string }).status).toBe('open');

    const closed = await fetch(`${support.url}/api/v1/support/tickets/${created.id}/close`, {
      method: 'POST',
      headers,
    });
    expect(closed.status).toBe(200);
    const statusMail = await emails.nextJob(userEmail(userId), 'ticket_status');
    expect(statusMail.variables).toMatchObject({ number: 1, status: 'closed' });

    const rated = await fetch(`${support.url}/api/v1/support/tickets/${created.id}/rate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rating: 5 }),
    });
    expect(rated.status).toBe(200);
    expect(((await rated.json()) as { rating: number }).rating).toBe(5);

    const reopened = await fetch(`${support.url}/api/v1/support/tickets/${created.id}/reopen`, {
      method: 'POST',
      headers,
    });
    expect(reopened.status).toBe(200);
    expect(
      ((await reopened.json()) as { status: string; rating: number | null }).rating,
    ).toBeNull();

    expect(await outboxTypes(support)).toEqual(
      expect.arrayContaining([
        SUPPORT_EVENTS.ticketCreated,
        SUPPORT_EVENTS.ticketReplied,
        SUPPORT_EVENTS.ticketStatusChanged,
      ]),
    );
    for (const envelope of await outboxEnvelopes(support)) {
      expect(envelope).not.toContain(BODY_MARKER);
    }
    assertLogsScrubbed(logs.lines, [BODY_MARKER]);
  });

  it('lets a banned user open exactly one appeal per action and nothing else', async () => {
    const userId = '22222222-3333-4444-5555-666666666666';
    const actionId = '01234567-89ab-cdef-0123-456789abcdef';
    const banned = jsonHeaders({ sub: userId, account_state: 'banned' });
    const regular = await fetch(`${support.url}/api/v1/support/tickets`, {
      method: 'POST',
      headers: banned,
      body: JSON.stringify({
        category_id: 'account',
        subject: 'Help',
        body: 'Please unban me.',
      }),
    });
    expect(regular.status).toBe(403);
    expect(await regular.json()).toMatchObject({ code: 'ACCOUNT_STATE_NOT_ALLOWED' });

    const appeal = await fetch(`${support.url}/api/v1/support/appeals`, {
      method: 'POST',
      headers: banned,
      body: JSON.stringify({ action_id: actionId, body: 'I did not do this.' }),
    });
    expect(appeal.status).toBe(201);
    const opened = (await appeal.json()) as { id: string; appeal: boolean; category_id: string };
    expect(opened.appeal).toBe(true);
    expect(opened.category_id).toBe('appeal');

    const again = await fetch(`${support.url}/api/v1/support/appeals`, {
      method: 'POST',
      headers: banned,
      body: JSON.stringify({ action_id: actionId, body: 'Please.' }),
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'SUPPORT_APPEAL_EXISTS' });

    const other = await fetch(`${support.url}/api/v1/support/appeals`, {
      method: 'POST',
      headers: banned,
      body: JSON.stringify({
        action_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        body: 'A different action.',
      }),
    });
    expect(other.status).toBe(201);

    const viaRpc = await rpcRequest<{ ticket_id: string }>(
      gateway,
      'support',
      CREATE_APPEAL_METHOD,
      { user_id: userId, action_id: actionId, body: 'From safety' },
    );
    expect(viaRpc.status).toBe('ok');
    if (viaRpc.status === 'ok') expect(viaRpc.data.ticket_id).toBe(opened.id);
  });

  it('stores canned responses and uses them in a staff reply', async () => {
    const staff = jsonHeaders({
      sub: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      permissions: ['support.tickets.staff'],
    });
    const created = await fetch(`${support.url}/api/v1/admin/support/macros`, {
      method: 'POST',
      headers: staff,
      body: JSON.stringify({ name: 'Reset password', body: 'Please use the reset form.' }),
    });
    expect(created.status).toBe(201);
    const macro = (await created.json()) as { id: string };

    const userId = '33333333-4444-5555-6666-777777777777';
    const ticketRes = await fetch(`${support.url}/api/v1/support/tickets`, {
      method: 'POST',
      headers: jsonHeaders({ sub: userId }),
      body: JSON.stringify({
        category_id: 'account',
        subject: 'Password',
        body: 'I forgot it.',
      }),
    });
    const ticket = (await ticketRes.json()) as { id: string };
    const replied = await fetch(
      `${support.url}/api/v1/admin/support/tickets/${ticket.id}/replies`,
      {
        method: 'POST',
        headers: staff,
        body: JSON.stringify({ macro_id: macro.id }),
      },
    );
    expect(replied.status).toBe(200);
    const detail = (await replied.json()) as { messages: { body: string }[] };
    expect(detail.messages.at(-1)?.body).toBe('Please use the reset form.');
  });

  it('reminds then auto-closes tickets waiting on the user', async () => {
    const userId = '44444444-5555-6666-7777-888888888888';
    const staffId = 'cccccccc-dddd-eeee-ffff-000000000000';
    const opened = await fetch(`${support.url}/api/v1/support/tickets`, {
      method: 'POST',
      headers: jsonHeaders({ sub: userId }),
      body: JSON.stringify({
        category_id: 'other',
        subject: 'Waiting',
        body: 'Hello',
      }),
    });
    const ticket = (await opened.json()) as { id: string; number: number };
    await fetch(`${support.url}/api/v1/admin/support/tickets/${ticket.id}/replies`, {
      method: 'POST',
      headers: jsonHeaders({ sub: staffId, permissions: ['support.tickets.staff'] }),
      body: JSON.stringify({ body: 'Can you send a screenshot?' }),
    });

    const waiting = await support.context.db
      .selectFrom('tickets')
      .select('waiting_since')
      .where('id', '=', ticket.id)
      .executeTakeFirstOrThrow();
    await support.context.db
      .updateTable('tickets')
      .set({ waiting_since: new Date(waiting.waiting_since.getTime() - 4 * 86_400_000) })
      .where('id', '=', ticket.id)
      .execute();
    await publishCronTick(scheduler.js, AUTO_CLOSE_JOB, new Date());
    const reminder = await emails.nextJob(userEmail(userId), 'ticket_reminder');
    expect(reminder.variables).toMatchObject({ number: ticket.number });

    const current = await support.context.db
      .selectFrom('tickets')
      .select('waiting_since')
      .where('id', '=', ticket.id)
      .executeTakeFirstOrThrow();
    await support.context.db
      .updateTable('tickets')
      .set({ waiting_since: new Date(current.waiting_since.getTime() - 8 * 86_400_000) })
      .where('id', '=', ticket.id)
      .execute();
    await publishCronTick(scheduler.js, AUTO_CLOSE_JOB, new Date());
    await vi.waitFor(async () => {
      const row = await support.context.db
        .selectFrom('tickets')
        .select('status')
        .where('id', '=', ticket.id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('closed');
    });
    const closedMail = await emails.nextJob(userEmail(userId), 'ticket_status');
    expect(closedMail.variables).toMatchObject({ number: ticket.number, status: 'closed' });
  });

  it('answers user_tickets, exports, erases, and keeps staff metrics', async () => {
    const userId = '55555555-6666-7777-8888-999999999999';
    await fetch(`${support.url}/api/v1/support/tickets`, {
      method: 'POST',
      headers: jsonHeaders({ sub: userId }),
      body: JSON.stringify({
        category_id: 'billing',
        subject: 'Charge',
        body: 'Unexpected charge',
      }),
    });
    const listed = await rpcRequest<{ items: { id: string }[] }>(
      gateway,
      'support',
      USER_TICKETS_METHOD,
      { user_id: userId },
    );
    expect(listed.status).toBe('ok');
    if (listed.status === 'ok') expect(listed.data.items.length).toBeGreaterThan(0);

    const exported = await rpcRequest<{ data: { tickets: { subject: string }[] } }>(
      gateway,
      'support',
      EXPORT_USER_METHOD,
      { user_id: userId },
    );
    expect(exported.status).toBe('ok');
    if (exported.status === 'ok') {
      expect(exported.data.data.tickets.some((ticket) => ticket.subject === 'Charge')).toBe(true);
    }

    await publishEvent(
      gateway.js,
      createEvent({
        type: USER_DELETED_EVENT,
        actor: { type: 'system', id: 'identity' },
        subject: { type: 'user', id: userId },
        data: { held: false },
      }),
    );
    await vi.waitFor(async () => {
      const row = await support.context.db
        .selectFrom('tickets')
        .select(['user_id', 'subject'])
        .where('subject', '=', '')
        .executeTakeFirst();
      expect(row?.user_id).toBeNull();
    });

    const metrics = await fetch(`${support.url}/api/v1/admin/support/metrics`, {
      headers: jsonHeaders({
        sub: 'dddddddd-eeee-ffff-0000-111111111111',
        permissions: ['support.tickets.staff'],
      }),
    });
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({
      csat: expect.any(Array) as unknown,
      by_category: expect.any(Array) as unknown,
    });
  });
});
