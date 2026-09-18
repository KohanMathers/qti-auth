import { InvalidMessageError, type WorkMessage } from '@qtiauth/bus';
import { sections } from '@qtiauth/config';
import { createEmailJob, EMAIL_TEMPLATES, type EmailJob } from '@qtiauth/email';
import { createLogger } from '@qtiauth/observability';
import { assertLogsScrubbed, captureLogs } from '@qtiauth/observability/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { DeliveryLog, DeliveryRecord } from './deliveries.ts';
import type { NotifierMetrics } from './metrics.ts';
import type { EmailProvider } from './providers.ts';
import { createEmailSender, EmailSendError } from './sender.ts';
import { DEFAULT_TEMPLATES_DIR, loadTemplates, type TemplateSet } from './templates.ts';

const LINK = 'https://me.example.com/magic-link?token=secret-magic-token';
const USER_ID = '0199a0e0-0000-7000-8000-00000000abcd';

let templates: TemplateSet;

beforeAll(async () => {
  templates = await loadTemplates({
    definitions: EMAIL_TEMPLATES,
    dirs: [DEFAULT_TEMPLATES_DIR],
    defaultLocale: 'en-GB',
    brand: {
      product_name: 'Example Account',
      company_name: 'Example Ltd',
      support_email: 'support@example.com',
      primary_color: '#3b82f6',
    },
  });
});

function memoryLog(): DeliveryLog & { rows: Map<string, DeliveryRecord> } {
  const rows = new Map<string, DeliveryRecord>();
  return {
    rows,
    status: (id) => Promise.resolve(rows.get(id)?.status ?? null),
    record: (delivery) => {
      if (rows.get(delivery.id)?.status !== 'sent') rows.set(delivery.id, delivery);
      return Promise.resolve();
    },
  };
}

function job(): EmailJob {
  return createEmailJob(
    {
      template: 'magic_link',
      to: { address: 'someone@example.com', name: 'Sam' },
      locale: 'fr-FR',
      userId: USER_ID,
      variables: { link: LINK, expires_in_minutes: 15 },
    },
    new Date('2026-09-17T09:00:00Z'),
  );
}

function message(data: unknown, attempt = 1): WorkMessage<unknown> {
  return { subject: 'qtiauth.work.notifier.email.high', data, attempt, id: null };
}

function setup(send: EmailProvider['send']) {
  const logs = captureLogs();
  const deliveries = memoryLog();
  const metrics = {
    sendAttempt: vi.fn(),
    delivery: vi.fn(),
    deliveryDelay: vi.fn(),
    webhookAttempt: vi.fn(),
    webhookDelivery: vi.fn(),
    webhookDeliveryDelay: vi.fn(),
    webhookDisabled: vi.fn(),
  } satisfies NotifierMetrics;
  const provider: EmailProvider = { name: 'smtp', send: vi.fn(send), close: vi.fn() };
  const sender = createEmailSender({
    templates,
    provider,
    from: sections.email.parse({}).from,
    maxAttempts: 3,
    deliveries,
    log: createLogger({
      service: 'notifier',
      config: sections.observability.parse({ logs: { user_id_hash_key: 'test' } }).logs,
      destination: logs.destination,
    }),
    metrics,
    now: () => Date.parse('2026-09-17T09:00:02Z'),
  });
  return { sender, provider, deliveries, metrics, logs };
}

describe('createEmailSender', () => {
  it('renders the template, sends it from the category sender and logs the delivery', async () => {
    const { sender, provider, deliveries, metrics, logs } = setup(() =>
      Promise.resolve({ provider_message_id: '<abc@example.com>' }),
    );
    const email = job();

    await sender(message(email));

    const [[sent] = []] = vi.mocked(provider.send).mock.calls;
    expect(sent).toMatchObject({
      id: email.delivery_id,
      from: { name: 'Example Auth', address: 'auth@example.com' },
      to: { name: 'Sam', address: 'someone@example.com' },
      subject: 'Your sign-in link for Example Account',
    });
    expect(sent?.text).toContain(LINK);
    expect(deliveries.rows.get(email.delivery_id)).toEqual({
      id: email.delivery_id,
      template: 'magic_link',
      locale: 'en-GB',
      category: 'auth',
      priority: 'high',
      recipient: 'someone@example.com',
      user_id: USER_ID,
      status: 'sent',
      attempts: 1,
      provider: 'smtp',
      provider_message_id: '<abc@example.com>',
      last_error: null,
      queued_at: new Date('2026-09-17T09:00:00Z'),
      sent_at: new Date('2026-09-17T09:00:02Z'),
    });
    expect(metrics.sendAttempt).toHaveBeenCalledWith('smtp', 'ok', expect.any(Number));
    expect(metrics.delivery).toHaveBeenCalledWith('smtp', 'magic_link', 'sent');
    expect(metrics.deliveryDelay).toHaveBeenCalledWith('high', 2);
    assertLogsScrubbed(logs.lines, [LINK, 'secret-magic-token', USER_ID, 'someone@example.com']);
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ message: 'email sent', delivery_id: email.delivery_id }),
    );
  });

  it('records a failed send as retrying and throws so the queue retries it', async () => {
    const { sender, deliveries, metrics } = setup(() =>
      Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:587')),
    );
    const email = job();

    await expect(sender(message(email, 2))).rejects.toBeInstanceOf(EmailSendError);

    expect(deliveries.rows.get(email.delivery_id)).toMatchObject({
      status: 'retrying',
      attempts: 2,
      provider_message_id: null,
      last_error: 'Error: connect ECONNREFUSED 127.0.0.1:587',
      sent_at: null,
    });
    expect(metrics.sendAttempt).toHaveBeenCalledWith('smtp', 'error', expect.any(Number));
    expect(metrics.delivery).toHaveBeenCalledWith('smtp', 'magic_link', 'retrying');
  });

  it('marks the email failed on the last attempt instead of retrying again', async () => {
    const { sender, deliveries, metrics, logs } = setup(() =>
      Promise.reject(new Error('550 mailbox unavailable')),
    );
    const email = job();

    await sender(message(email, 3));

    expect(deliveries.rows.get(email.delivery_id)).toMatchObject({
      status: 'failed',
      attempts: 3,
    });
    expect(metrics.delivery).toHaveBeenCalledWith('smtp', 'magic_link', 'failed');
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'email failed, giving up' }),
    );
  });

  it('does not send an email again once it has been sent', async () => {
    const { sender, provider } = setup(() =>
      Promise.resolve({ provider_message_id: '<abc@example.com>' }),
    );
    const email = job();

    await sender(message(email));
    await sender(message(email, 2));

    expect(provider.send).toHaveBeenCalledOnce();
  });

  it('does not retry after a successful send if the delivery log write fails', async () => {
    const { sender, provider, deliveries, logs } = setup(() =>
      Promise.resolve({ provider_message_id: '<abc@example.com>' }),
    );
    deliveries.record = () => Promise.reject(new Error('db unavailable'));
    const email = job();

    await sender(message(email));

    expect(provider.send).toHaveBeenCalledOnce();
    expect(logs.records()).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'email sent but delivery was not recorded',
      }),
    );
  });

  it('rejects jobs it could never send', async () => {
    const { sender, provider } = setup(() =>
      Promise.resolve({ provider_message_id: '<abc@example.com>' }),
    );
    const email = job();

    await expect(sender(message({ ...email, to: { address: 'nobody' } }))).rejects.toBeInstanceOf(
      InvalidMessageError,
    );
    await expect(sender(message({ ...email, template: 'unknown' }))).rejects.toThrow(
      'uses unknown template unknown',
    );
    await expect(sender(message({ ...email, variables: { link: LINK } }))).rejects.toThrow(
      'has invalid variables for magic_link: expires_in_minutes',
    );
    expect(provider.send).not.toHaveBeenCalled();
  });
});
