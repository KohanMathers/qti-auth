import { sections } from '@qtiauth/config';
import { describe, expect, it } from 'vitest';

import { valkeyOptions } from './connect.ts';

describe('valkeyOptions', () => {
  it('fails fast instead of queueing commands while disconnected', () => {
    const options = valkeyOptions(sections.valkey.parse({}), 'gateway');
    expect(options).toMatchObject({
      host: 'valkey',
      port: 6379,
      db: 0,
      connectionName: 'qtiauth-gateway',
      commandTimeout: 1_000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    expect(options).not.toHaveProperty('password');
    expect(options).not.toHaveProperty('tls');
  });

  it('passes credentials and TLS when set', () => {
    const options = valkeyOptions(
      sections.valkey.parse({ user: 'gateway', password: 'secret', tls: { enabled: true } }),
      'gateway',
    );
    expect(options).toMatchObject({ username: 'gateway', password: 'secret', tls: {} });
  });
});
