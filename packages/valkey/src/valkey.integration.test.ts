import { sections } from '@qtiauth/config';
import { startValkey } from '@qtiauth/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeValkey, connectValkey, type Valkey } from './connect.ts';
import { valkeyHealthCheck } from './health.ts';

let container: Awaited<ReturnType<typeof startValkey>>;
let client: Valkey;

beforeAll(async () => {
  container = await startValkey();
  client = connectValkey(
    sections.valkey.parse({ host: container.getHost(), port: container.getPort() }),
    'test',
  );
  if (client.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('end', () => {
        reject(new Error('valkey connection ended before becoming ready'));
      });
    });
  }
});

afterAll(async () => {
  await closeValkey(client);
  await container.stop();
});

describe('connectValkey', () => {
  it('connects and passes the health check', async () => {
    await expect(valkeyHealthCheck(client)()).resolves.toBeUndefined();
    await client.set('qtiauth:test', 'value');
    expect(await client.get('qtiauth:test')).toBe('value');
  });

  it('fails the health check straight away when Valkey is unreachable', async () => {
    const unreachable = connectValkey(
      sections.valkey.parse({ host: '127.0.0.1', port: 1, connect_timeout: '200ms' }),
      'test',
    );
    await expect(valkeyHealthCheck(unreachable)()).rejects.toThrow();
    await closeValkey(unreachable);
  });
});
