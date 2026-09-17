import { sections } from '@qtiauth/config';
import { afterEach, describe, expect, it } from 'vitest';

import type { EmailMessage } from './providers.ts';
import { smtpProvider, smtpTransportOptions } from './smtp.ts';
import { freePort, startTestSmtpServer, type TestSmtpServer } from './testing.ts';

const message: EmailMessage = {
  id: '0199a0e0-0000-7000-8000-000000000001',
  from: { name: 'Example Auth', address: 'auth@example.com' },
  to: { name: 'Sam', address: 'someone@example.com' },
  subject: 'Your sign-in link',
  text: 'Open https://me.example.com/magic',
  html: '<p>Open <a href="https://me.example.com/magic">the link</a></p>',
};

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

function smtp(settings: Record<string, unknown>) {
  const provider = smtpProvider(sections.email.parse({ smtp: settings }).smtp);
  cleanup.push(() => provider.close());
  return provider;
}

async function server(
  options?: Parameters<typeof startTestSmtpServer>[0],
): Promise<TestSmtpServer> {
  const started = await startTestSmtpServer(options);
  cleanup.push(() => started.stop());
  return started;
}

describe('smtpTransportOptions', () => {
  it('maps each security mode to the matching TLS behaviour', () => {
    const options = (security: string) =>
      smtpTransportOptions(sections.email.parse({ smtp: { security } }).smtp);
    expect(options('starttls')).toMatchObject({
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
    });
    expect(options('tls')).toMatchObject({ secure: true, requireTLS: false, ignoreTLS: false });
    expect(options('none')).toMatchObject({ secure: false, requireTLS: false, ignoreTLS: true });
    expect(options('none')).not.toHaveProperty('auth');
  });
});

describe('smtpProvider', () => {
  it('sends the text and HTML parts with the delivery ID, authenticating when a user is set', async () => {
    const { port, received } = await server({ users: { mailer: 'hunter2' } });
    const provider = smtp({
      host: '127.0.0.1',
      port,
      security: 'none',
      user: 'mailer',
      password: 'hunter2',
    });

    const result = await provider.send(message);

    expect(result.provider_message_id).toMatch(/^<.+>$/);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      from: 'auth@example.com',
      to: ['someone@example.com'],
      subject: 'Your sign-in link',
      text: 'Open https://me.example.com/magic',
      user: 'mailer',
    });
    expect(received[0]?.html).toContain('href="https://me.example.com/magic"');
    expect(received[0]?.headers.get('x-qtiauth-delivery-id')).toBe(message.id);
  });

  it('fails the send when the server is down, so the queue can retry it', async () => {
    const port = await freePort();
    const provider = smtp({ host: '127.0.0.1', port, security: 'none', connect_timeout: '1s' });

    await expect(provider.send(message)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('refuses to send in plain text when STARTTLS is required', async () => {
    const { port, received } = await server();
    const provider = smtp({ host: '127.0.0.1', port, security: 'starttls' });

    await expect(provider.send(message)).rejects.toThrow();
    expect(received).toEqual([]);
  });
});
